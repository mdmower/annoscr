ts_sources = files(
  'main.ts',
  'application.ts',
  'window.ts',
)

ts_outputs = [
  'main.js',
  'application.js',
  'window.js',
]

compile_ts = custom_target('compile-ts',
  build_by_default: true,
  input: ts_sources,
  output: ts_outputs,
  depend_files: [
    meson.project_source_root() / 'tsconfig.json',
    meson.project_source_root() / 'src' / 'globals.d.ts',
  ],
  command: [
    tsc,
    '--project', meson.project_source_root() / 'tsconfig.json',
    '--outDir', '@OUTDIR@',
    '--rootDir', meson.current_source_dir(),
  ],
  install: true,
  install_dir: pkgdatadir / 'js',
)

launcher_conf = configuration_data()
launcher_conf.set('gjs', gjs.full_path())
launcher_conf.set('pkgdatadir', pkgdatadir)

configure_file(
  input: 'annoscr.in',
  output: 'annoscr',
  configuration: launcher_conf,
  install: true,
  install_dir: get_option('bindir'),
  install_mode: 'rwxr-xr-x',
)
