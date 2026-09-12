project('xworkd', 'c',
  version: '0.1.0',
  default_options: ['c_std=c11', 'warning_level=1', 'buildtype=release'])

cc = meson.get_compiler('c')

# ---- X11 / 系统库 ----
deps = []
foreach p : ['x11', 'xext', 'xtst', 'xfixes', 'xrandr']
  d = dependency(p, required: false)
  if not d.found()
    d = cc.find_library(p, required: true)
  endif
  deps += d
endforeach

pam_dep = dependency('pam', required: false)
if not pam_dep.found()
  pam_dep = cc.find_library('pam', required: false)
endif
deps += pam_dep

crypt_dep = cc.find_library('crypt', required: false)
deps += crypt_dep

# ---- x264（H.264 软件编码，静态链接，无 FFmpeg/动态依赖） ----
# 优先系统静态库 libx264.a（libx264-dev）；
# 缺失时回退 third_party/x264 自建的静态库（无 libx264-dev 的环境：
#   cd third_party/x264 && ./configure --enable-static --disable-cli \
#       --disable-shared --disable-asm && make
#   生成 libx264.a 后本构建即可直接使用）
x264_dep = cc.find_library('x264', required: false, static: true)
if not x264_dep.found()
  third_x264 = meson.current_source_dir() / 'third_party' / 'x264' / 'libx264.a'
  if import('fs').is_file(third_x264)
    x264_dep = declare_dependency(
      link_args: [third_x264],
      include_directories: include_directories('third_party/x264'))
  endif
endif
if not x264_dep.found()
  error('找不到静态 libx264：请安装 libx264-dev，或在 third_party/x264 下先构建 libx264.a（见注释）')
endif
deps += x264_dep

opus_dep = dependency('opus', required: false)
if not opus_dep.found()
  opus_dep = cc.find_library('opus', required: true)
endif
deps += opus_dep

m_dep = cc.find_library('m', required: false)
deps += m_dep

threads_dep = dependency('threads')
deps += threads_dep

executable('xworkd',
  sources: [
    'src/main.c',
    'src/util.c',
    'src/msgqueue.c',
    'src/net.c',
    'src/http.c',
    'src/ws.c',
    'src/ws_parser.c',
    'src/eventloop.c',
    'src/auth.c',
    'src/session.c',
    'src/session_msg.c',
    'src/sessproc.c',
    'src/sess_table.c',
    'src/audio.c',
    'src/clip.c',
    'src/capture.c',
    'src/localsess.c',
    'src/encoder.c',
    'src/input.c',
    'src/im.c',
  ],
  dependencies: deps,
  install: true)

# ---- 输入法中继引擎 xworkd-im（可选目标）----------------------------------
# 只在装了 libibus-1.0-dev 时构建：它不是服务端的运行必需件（用户不用本机输入法
# 就完全用不到），缺开发包时不应挡住主程序构建。详见 docs/input-method-local.md。
# libibus 只在**引擎进程**里用；xworkd 本体不链接它，两者靠 AF_UNIX 通道通信。
ibus_dep = dependency('ibus-1.0', required: false)
if ibus_dep.found()
  executable('xworkd-im',
    sources: ['im/xworkd-im.c'],
    include_directories: include_directories('src'),
    dependencies: [ibus_dep, dependency('glib-2.0')],
    install: true,
    install_dir: get_option('libexecdir') / 'xworkd')
  install_data('im/xworkd-im.xml',
    install_dir: get_option('datadir') / 'ibus' / 'component')
  message('xworkd-im: 已启用（ibus ' + ibus_dep.version() + '）')
else
  warning('xworkd-im: 跳过（缺 libibus-1.0-dev，apt install libibus-1.0-dev 后可启用）')
endif

# ---- 单元测试（纯逻辑模块，不依赖 X，可无头运行） ----
test_units = [
  ['test-util', ['test/test_util.c', 'src/util.c']],
  ['test-msgq', ['test/test_msgq.c', 'src/msgqueue.c']],
  ['test-ws', ['test/test_ws.c', 'src/ws_parser.c']],
  ['test-http-util', ['test/test_http_util.c', 'src/util.c']],
  ['test-im', ['test/test_im.c', 'src/im.c', 'src/util.c']],
]
foreach t : test_units
  test(t[0], executable(t[0], t[1],
        include_directories: include_directories('src'),
        dependencies: threads_dep))
endforeach
