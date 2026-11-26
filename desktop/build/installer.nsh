; Reglas automáticas de Firewall para Precios al Día LAN (NSIS)
; Solo permite acceso desde dispositivos en la misma subred local (Wi-Fi/cable del negocio).

!macro customInstall
  ; Limpiar reglas previas si existieran antes de volver a crearlas
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="PreciosAlDiaLAN-HTTP-TCP"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="PreciosAlDiaLAN-Discovery-UDP"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="PreciosAlDiaLAN-App"'
  Pop $0

  ; Puerto HTTP + SSE del servidor principal LAN (solo subred local)
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="PreciosAlDiaLAN-HTTP-TCP" dir=in action=allow protocol=TCP localport=47800 remoteip=localsubnet profile=any enable=yes description="Precios al Dia LAN HTTP y SSE (solo red local)"'
  Pop $0

  ; Puerto UDP de descubrimiento automático en la red del local (solo subred local)
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="PreciosAlDiaLAN-Discovery-UDP" dir=in action=allow protocol=UDP localport=47801 remoteip=localsubnet profile=any enable=yes description="Precios al Dia LAN descubrimiento UDP (solo red local)"'
  Pop $0

  ; Ejecutable de la aplicación (cubre mDNS/respuestas en la subred local)
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="PreciosAlDiaLAN-App" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" remoteip=localsubnet profile=any enable=yes description="Precios al Dia LAN aplicacion (solo red local)"'
  Pop $0
!macroend

!macro customUnInstall
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="PreciosAlDiaLAN-HTTP-TCP"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="PreciosAlDiaLAN-Discovery-UDP"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="PreciosAlDiaLAN-App"'
  Pop $0
!macroend
