; SmartScan uninstall: program files are removed; user documents are NEVER deleted.
!macro customUnInstall
  ; Remove the "start with Windows" entry if the user had enabled it
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.smartscan.desktop"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SmartScan"
!macroend
