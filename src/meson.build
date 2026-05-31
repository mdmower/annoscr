ts_sources = files(
  'main.ts',
  'i18n.ts',
  'application.ts',
  'window.ts',
  'window_constants.ts',
  'gdk_color.ts',
  'dialogs.ts',
  'style_bar.ts',
  'zoom_controller.ts',
  'tool_bar.ts',
  'canvas_view.ts',
  'image_loader.ts',
  'actions.ts',
  'text_editor.ts',
  'image_transforms.ts',
  'exporter.ts',
  'settings.ts',
  'preferences.ts',
  'shortcuts_dialog.ts',
  'screenshot.ts',
  'font_catalogue.ts',
)

ts_outputs = [
  'main.js',
  'i18n.js',
  'application.js',
  'window.js',
  'window_constants.js',
  'gdk_color.js',
  'dialogs.js',
  'style_bar.js',
  'zoom_controller.js',
  'tool_bar.js',
  'canvas_view.js',
  'image_loader.js',
  'actions.js',
  'text_editor.js',
  'image_transforms.js',
  'exporter.js',
  'settings.js',
  'preferences.js',
  'shortcuts_dialog.js',
  'screenshot.js',
  'font_catalogue.js',
]

version_js = custom_target('version-js',
  build_by_default: true,
  input: package_json,
  output: 'version.js',
  command: [
    node,
    '-e',
    'const fs = require("fs"); ' +
    'const v = require(process.argv[1]).version; ' +
    'fs.writeFileSync(process.argv[2], "export const APP_VERSION = " + JSON.stringify(v) + ";");',
    '@INPUT@',
    '@OUTPUT@',
  ],
  install: true,
  install_dir: pkgdatadir / 'js',
)

compile_ts = custom_target('compile-ts',
  build_by_default: true,
  input: ts_sources,
  output: ts_outputs,
  depend_files: [
    meson.project_source_root() / 'tsconfig.json',
    meson.project_source_root() / 'src' / 'globals.d.ts',
    meson.project_source_root() / 'src' / 'version.d.ts',
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
launcher_conf.set('localedir', localedir)
launcher_conf.set('srcicons', meson.project_source_root() / 'data' / 'icons')

launcher = configure_file(
  input: 'annoscr.in',
  output: 'annoscr',
  configuration: launcher_conf,
  install: true,
  install_dir: get_option('bindir'),
  install_mode: 'rwxr-xr-x',
)

# configure_file's install_mode doesn't affect the build-tree copy, so the
# launcher comes out 0644 there. Mark it executable so `./build/src/annoscr`
# runs without a manual chmod.
meson.add_postconf_script(find_program('chmod'), '+x', launcher.full_path())
