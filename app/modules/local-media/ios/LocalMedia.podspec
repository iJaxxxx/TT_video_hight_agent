Pod::Spec.new do |s|
  s.name           = 'LocalMedia'
  s.version        = '0.1.0'
  s.summary        = '本地解析：抽音频、拼接导出（AVFoundation）'
  s.author         = ''
  s.homepage       = 'https://github.com/iJaxxxx'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
