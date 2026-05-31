project('annoscr',
  version: '0.1.0',
  meson_version: '>= 1.4.0',
  license: 'GPL-3.0-or-later',
)

i18n = import('i18n')

app_id = 'com.cmphys.Annoscr'
app_path = '/com/cmphys/Annoscr'
pkgdatadir = get_option('prefix') / get_option('datadir') / meson.project_name()
localedir = get_option('prefix') / get_option('localedir')
gjs = find_program('gjs', required: true)

# TypeScript is compiled with the project-local tsc (node_modules/.bin/tsc),
# which runs under Node.js. Check both up front so a missing toolchain fails
# configuration with an actionable message instead of a cryptic tsc error later.
node = find_program('node', required: false)
if not node.found()
  error(
    'Node.js is required to build Annoscr but the `node` executable was not ' +
    'found on PATH.\n' +
    'Install it with your package manager (e.g. `sudo apt install nodejs`) or ' +
    'download Node.js from https://nodejs.org/en/download/ and install it ' +
    'manually, then re-run the build.'
  )
endif

fs = import('fs')
local_tsc = meson.project_source_root() / 'node_modules' / '.bin' / 'tsc'
if not fs.exists(local_tsc)
  error(
    'The project-local TypeScript compiler was not found at\n' +
    '  ' + local_tsc + '\n' +
    'Install the npm packages first by running `npm install` in the project ' +
    'root, then re-run the build.'
  )
endif

tsc = find_program(local_tsc, required: true)

subdir('data')
subdir('src')
subdir('po')
