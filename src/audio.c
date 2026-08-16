/* audio.c —— 桌面音频传输：PipeWire 采集（pw-record）→ Opus 编码 → MSG_AUDIO。
 * 采集命令录默认 sink 的输出（桌面应用播放的声音），
 * 以 20ms 帧（48kHz 立体声 s16）喂给 FFmpeg Opus 编码器推流。 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#include "session.h"
#include "protocol.h"
#include "util.h"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/wait.h>
#include <pwd.h>
#include <grp.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/time.h>

#define AUDIO_RATE 48000
#define AUDIO_CHANNELS 2
#define AUDIO_FRAME_MS 20
#define AUDIO_SAMPLES (AUDIO_RATE * AUDIO_FRAME_MS / 1000)   /* 960 */
#define AUDIO_FRAME_BYTES (AUDIO_SAMPLES * AUDIO_CHANNELS * 2) /* 3840 */

/* 创建 Opus 编码器 */
static AVCodecContext *audio_encoder_open(void)
{
    const AVCodec *codec = avcodec_find_encoder(AV_CODEC_ID_OPUS);
    if (!codec)
    {
        log_err("找不到 Opus 编码器");
        return NULL;
    }
    AVCodecContext *ctx = avcodec_alloc_context3(codec);
    if (!ctx)
        return NULL;
    ctx->sample_fmt = AV_SAMPLE_FMT_S16;
    ctx->sample_rate = AUDIO_RATE;
    ctx->bit_rate = 128000;
    ctx->ch_layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_STEREO;
    if (avcodec_open2(ctx, codec, NULL) < 0)
    {
        avcodec_free_context(&ctx);
        return NULL;
    }
    return ctx;
}

static void *audio_thread(void *arg)
{
    runtime *rt = arg;
    int fd = -1;
    pid_t pid = -1;

    int pfd[2];
    if (pipe(pfd) != 0)
        return NULL;
    pid = fork();
    if (pid < 0)
    {
        close(pfd[0]);
        close(pfd[1]);
        return NULL;
    }
    if (pid == 0)
    {
        /* 子进程：pw-record 输出 PCM 到管道 */
        /* 必须以桌面用户身份连接其 PipeWire 会话 */
        struct passwd *pw = getpwnam(rt->proc.user);
        if (getuid() == 0 && pw)
        {
            initgroups(pw->pw_name, pw->pw_gid);
            setgid(pw->pw_gid);
            setuid(pw->pw_uid);
            char rt_dir[64];
            snprintf(rt_dir, sizeof rt_dir, "/run/user/%u", pw->pw_uid);
            setenv("XDG_RUNTIME_DIR", rt_dir, 1);
        }
        /* 独立进程组，便于父进程 kill(-pid) 连同后台 pw-record 一起回收 */
        setpgid(0, 0);
        dup2(pfd[1], 1);
        close(pfd[0]);
        close(pfd[1]);

        /* 采集目标：默认输出 sink 的 monitor 端口（桌面应用播放的声音）。
         * 不能再写死 auto_null——只有无硬件设备（Dummy Output）时它才存在，
         * 有真实声卡时会回退到默认 source（麦克风）导致没有声音。
         * 流程：查默认 sink → pw-record(--target=0) → pw-link 把 sink 的
         * monitor_FL/FR 接到录音流。20ms 延迟避免把图周期推到 VMware 模拟
         * 声卡无法承受的 4800 采样/周期。 */
        const char *disp = rt->proc.display_str;
        if (*disp == ':')
            disp++;
        char script[1024];
        snprintf(script, sizeof script,
                 "SINK=$(pw-metadata -n default 0 2>/dev/null | sed -n "
                 "'s/.*default\\.audio\\.sink.*\"name\":\"\\([^\"]*\\)\".*/\\1/p' "
                 "| head -n1); "
                 "[ -z \"$SINK\" ] && SINK=$(pw-cli ls Node 2>/dev/null | awk "
                 "'/node\\.name =/{line=$0} "
                 "/media\\.class = \\\"Audio\\/Sink\\\"/{"
                 "sub(/.*node\\.name = \\\"/,\"\",line); "
                 "sub(/\\\".*/,\"\",line); print line; exit}'); "
                 "NODE=xwd-audio-%s; "
                 "pw-record -P \"{ node.name = \\\"$NODE\\\" media.name = "
                 "\\\"$NODE\\\" }\" --target=0 --latency=20ms "
                 "--rate=48000 --channels=2 --format=s16 - & "
                 "REC=$!; "
                 "if [ -n \"$SINK\" ]; then "
                 "  i=0; "
                 "  while [ $i -lt 8 ]; do "
                 "    if pw-link \"$SINK:monitor_FL\" \"$NODE:input_FL\" "
                 ">/dev/null 2>&1; then "
                 "      pw-link \"$SINK:monitor_FR\" \"$NODE:input_FR\" "
                 ">/dev/null 2>&1; "
                 "      break; "
                 "    fi; "
                 "    sleep 0.5; i=$((i+1)); "
                 "  done; "
                 "fi; "
                 "wait $REC",
                 disp);
        execlp("/bin/sh", "sh", "-c", script, (char *)NULL);
        _exit(127);
    }
    close(pfd[1]);
    fd = pfd[0];
    rt->audio_pid = pid;

    AVCodecContext *ctx = audio_encoder_open();
    AVFrame *frame = av_frame_alloc();
    AVPacket *pkt = av_packet_alloc();
    if (!ctx || !frame || !pkt)
    {
        kill(-pid, SIGTERM);
        close(fd);
        return NULL;
    }
    frame->format = AV_SAMPLE_FMT_S16;
    frame->sample_rate = AUDIO_RATE;
    frame->ch_layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_STEREO;
    frame->nb_samples = AUDIO_SAMPLES;
    av_frame_get_buffer(frame, 0);

    uint8_t buf[AUDIO_FRAME_BYTES];
    size_t have = 0;
    int64_t pts = 0; /* 以样本为单位的单调 PTS */
    while (atomic_load(&rt->audio_running))
    {
        ssize_t n = read(fd, buf + have, sizeof buf - have);
        if (n <= 0)
        {
            if (n < 0 && (errno == EINTR || errno == EAGAIN))
                continue;
            break; /* 采集结束 */
        }
        have += (size_t)n;
        while (have >= AUDIO_FRAME_BYTES)
        {
            memcpy(frame->data[0], buf, AUDIO_FRAME_BYTES);
            memmove(buf, buf + AUDIO_FRAME_BYTES, have - AUDIO_FRAME_BYTES);
            have -= AUDIO_FRAME_BYTES;
            frame->pts = pts;
            pts += AUDIO_SAMPLES;
            if (avcodec_send_frame(ctx, frame) == 0)
            {
                while (avcodec_receive_packet(ctx, pkt) == 0)
                {
                    if (pkt->size > 0)
                    {
                        uint8_t *out = malloc(1 + (size_t)pkt->size);
                        out[0] = MSG_AUDIO;
                        memcpy(out + 1, pkt->data, (size_t)pkt->size);
                        conn *c = atomic_load(&rt->conn);
                        if (c)
                            net_push_take(c, out, 1 + (size_t)pkt->size, 1);
                        else
                            free(out);
                    }
                    av_packet_unref(pkt);
                }
            }
        }
    }

    kill(-pid, SIGTERM);
    waitpid(pid, NULL, 0);
    close(fd);
    av_packet_free(&pkt);
    av_frame_free(&frame);
    avcodec_free_context(&ctx);
    rt->audio_pid = 0;
    atomic_store(&rt->audio_running, 0);
    return NULL;
}

/* 启动音频采集与编码线程 */
int audio_start(runtime *rt)
{
    if (atomic_exchange(&rt->audio_running, 1))
        return 0; /* 已在运行 */
    if (pthread_create(&rt->audio_thread, NULL, audio_thread, rt) != 0)
    {
        atomic_store(&rt->audio_running, 0);
        return -1;
    }
    return 0;
}

/* 停止音频采集（幂等） */
void audio_stop(runtime *rt)
{
    if (!atomic_exchange(&rt->audio_running, 0))
        return;
    pthread_join(rt->audio_thread, NULL);
}
