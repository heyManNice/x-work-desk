project('xworkd', 'c',
  version: '0.1.0',
  default_options: ['c_std=c11', 'warning_level=1', 'buildtype=release'])

cc = meson.get_compiler('c')

# ---- 自建 x264（third_party/x264，由 make 构建） ----
x264_dir = meson.current_source_dir() / 'third_party' / 'x264'
x264_inc = include_directories('third_party/x264')
x264_lib = cc.find_library('x264', dirs: [x264_dir])

# ---- X11 / 系统库 ----
deps = []
foreach p : ['x11', 'xext', 'xtst']
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

m_dep = cc.find_library('m', required: false)
deps += m_dep

deps += dependency('threads')

executable('xworkd',
  sources: [
    'src/main.c',
    'src/util.c',
    'src/msgqueue.c',
    'src/net.c',
    'src/auth.c',
    'src/session.c',
    'src/capture.c',
    'src/encoder.c',
    'src/input.c',
  ],
  include_directories: x264_inc,
  dependencies: deps + [x264_lib],
  install: true)

# 前端构建（若存在 node_modules，则纳入 ninja 构建）
frontend = meson.current_source_dir() / 'frontend'
if import('fs').is_dir(frontend / 'node_modules')
  custom_target('frontend-build',
    command: ['sh', '-c', 'cd "$1" && npm run build', '_', frontend],
    output: 'frontend-stamp',
    build_by_default: true)
endif
