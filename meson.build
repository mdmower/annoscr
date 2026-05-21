project('annoscr',
  version: '0.1.0',
  meson_version: '>= 1.4.0',
  license: 'GPL-3.0-or-later',
)

i18n = import('i18n')

app_id = 'com.cmphys.Annoscr'
app_path = '/com/cmphys/Annoscr'
pkgdatadir = get_option('prefix') / get_option('datadir') / meson.project_name()
gjs = find_program('gjs', required: true)
tsc = find_program(
  meson.project_source_root() / 'node_modules' / '.bin' / 'tsc',
  'tsc',
  required: true,
)

subdir('data')
subdir('src')
subdir('po')
