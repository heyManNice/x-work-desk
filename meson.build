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

avcodec_dep = dependency('libavcodec', required: false)
if not avcodec_dep.found()
  avcodec_dep = cc.find_library('avcodec', required: true)
endif
deps += avcodec_dep

avutil_dep = dependency('libavutil', required: false)
if not avutil_dep.found()
  avutil_dep = cc.find_library('avutil', required: true)
endif
deps += avutil_dep

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

# ---- 单元测试（纯逻辑模块，不依赖 X/FFmpeg，可无头运行） ----
test_units = [
  ['test-util', ['test/test_util.c', 'src/util.c']],
  ['test-msgq', ['test/test_msgq.c', 'src/msgqueue.c']],
  ['test-ws', ['test/test_ws.c', 'src/ws_parser.c']],
]
foreach t : test_units
  test(t[0], executable(t[0], t[1],
        include_directories: include_directories('src'),
        dependencies: threads_dep))
endforeach
