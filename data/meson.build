desktop_conf = configuration_data()
desktop_conf.set('app_id', app_id)

desktop_file = i18n.merge_file(
  input: configure_file(
    input: '@0@.desktop.in'.format(app_id),
    output: '@0@.desktop.tmp'.format(app_id),
    configuration: desktop_conf,
  ),
  output: '@0@.desktop'.format(app_id),
  type: 'desktop',
  po_dir: meson.project_source_root() / 'po',
  install: true,
  install_dir: get_option('datadir') / 'applications',
)

metainfo_file = i18n.merge_file(
  input: '@0@.metainfo.xml.in'.format(app_id),
  output: '@0@.metainfo.xml'.format(app_id),
  po_dir: meson.project_source_root() / 'po',
  install: true,
  install_dir: get_option('datadir') / 'metainfo',
)

# Validate desktop file (best-effort; warn only if tool missing).
desktop_validate = find_program('desktop-file-validate', required: false)
if desktop_validate.found()
  test('validate-desktop', desktop_validate, args: [desktop_file])
endif

# Validate metainfo (best-effort).
appstreamcli = find_program('appstreamcli', required: false)
if appstreamcli.found()
  test('validate-metainfo', appstreamcli,
    args: ['validate', '--no-net', '--explain', metainfo_file])
endif

# Register the .annoscr document type (application/x-annoscr) so the file
# manager can open annotation files with Annoscr. The MIME database refresh is
# handled by the distro's install machinery (Debian dh triggers, Fedora's
# shared-mime-info file trigger, Arch's pacman hooks) — no maintainer scripts.
install_data(
  '@0@.mime.xml'.format(app_id),
  install_dir: get_option('datadir') / 'mime' / 'packages',
)

install_man('annoscr.1')

install_data(
  'icons' / 'hicolor' / 'scalable' / 'apps' / '@0@.svg'.format(app_id),
  install_dir: get_option('datadir') / 'icons' / 'hicolor' / 'scalable' / 'apps',
)

# Bundled symbolic tool icons (not present in the system theme). Resolved by
# name via the hicolor theme once installed; from the build tree the launcher
# adds the source dir to the icon search path.
install_data(
  'icons' / 'hicolor' / 'scalable' / 'actions' / 'annoscr-select-symbolic.svg',
  'icons' / 'hicolor' / 'scalable' / 'actions' / 'annoscr-pen-symbolic.svg',
  'icons' / 'hicolor' / 'scalable' / 'actions' / 'annoscr-highlighter-symbolic.svg',
  'icons' / 'hicolor' / 'scalable' / 'actions' / 'annoscr-text-symbolic.svg',
  'icons' / 'hicolor' / 'scalable' / 'actions' / 'annoscr-number-symbolic.svg',
  'icons' / 'hicolor' / 'scalable' / 'actions' / 'annoscr-line-symbolic.svg',
  'icons' / 'hicolor' / 'scalable' / 'actions' / 'annoscr-arrow-symbolic.svg',
  'icons' / 'hicolor' / 'scalable' / 'actions' / 'annoscr-rect-symbolic.svg',
  'icons' / 'hicolor' / 'scalable' / 'actions' / 'annoscr-oval-symbolic.svg',
  install_dir: get_option('datadir') / 'icons' / 'hicolor' / 'scalable' / 'actions',
)
