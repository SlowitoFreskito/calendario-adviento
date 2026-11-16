@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Cifrando los regalos de la carpeta regalos-originales...
echo.
node herramientas\cifrar.mjs
echo.
pause
