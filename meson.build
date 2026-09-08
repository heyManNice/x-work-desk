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
    'src/encoder.c',
    'src/input.c',
    'src/transfer.c',
  ],
  dependencies: deps,
  install: true)

# 前端构建（若存在 node_modules，则纳入 ninja 构建）
frontend = meson.current_source_dir() / 'frontend'
if import('fs').is_dir(frontend / 'node_modules')
  custom_target('frontend-build',
    command: ['sh', '-c', 'cd "$1" && npm run build', '_', frontend],
    output: 'frontend-stamp',
    build_by_default: true)
endif

# ---- 单元测试（纯逻辑模块，不依赖 X，可无头运行） ----
test_units = [
  ['test-util', ['test/test_util.c', 'src/util.c']],
  ['test-msgq', ['test/test_msgq.c', 'src/msgqueue.c']],
  ['test-ws', ['test/test_ws.c', 'src/ws_parser.c']],
  ['test-transfer', ['test/test_transfer.c', 'src/util.c']],
]
foreach t : test_units
  test(t[0], executable(t[0], t[1],
        include_directories: include_directories('src'),
        dependencies: threads_dep))
endforeach
