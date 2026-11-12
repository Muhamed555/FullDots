; Extra pages and steps for the FullDots setup wizard (makers/maker-nsis.ts).
; electron-builder's NSIS template calls these macros when they are defined.

; The first page: what FullDots is, and what this setup does.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to FullDots ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "FullDots gives you a small team of AI coworkers, the Dots, that run on your own computer.$\r$\n$\r$\nEach Dot has a role, the tools you grant it and, if you want, a computer of its own. Your workspace, chats and keys stay in your user folder on this machine.$\r$\n$\r$\nThis setup installs the FullDots app and adds it to the Start menu. Click Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; FullDots 2.1.0 installed itself with Squirrel into %LOCALAPPDATA%\FullDots. Remove that copy so
; there is one FullDots, in the folder chosen here. Your workspace is in %APPDATA%\FullDots and
; is not touched.
!macro customInstall
  ; Never when this install went into that same folder.
  StrCmp "$INSTDIR" "$LOCALAPPDATA\FullDots" fulldots_no_squirrel 0
  IfFileExists "$LOCALAPPDATA\FullDots\Update.exe" 0 fulldots_no_squirrel
    DetailPrint "Removing the earlier FullDots installation…"
    ExecWait '"$LOCALAPPDATA\FullDots\Update.exe" --uninstall -s'
  fulldots_no_squirrel:
!macroend
