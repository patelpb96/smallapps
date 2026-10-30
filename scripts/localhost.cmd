@echo off
rem Double-click (or `explorer.exe scripts\localhost.cmd`) to run the localhost browser.
rem Launching through Explorer matters: a server started inside a sandboxed or
rem job-wrapped terminal sees a filtered socket table with every owner PID as 0.
title localhost browser
node "%~dp0localhost-server.js" 4180 --open
