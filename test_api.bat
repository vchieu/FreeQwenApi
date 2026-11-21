@echo off
REM Simple batch script to test the API

echo.
echo ╔════════════════════════════════════════╗
echo ║  FreeQwenApi - API Test                ║
echo ╚════════════════════════════════════════╝
echo.

echo Running Node.js tests...
echo.

cd /d D:\Users\Dima\Desktop\FreeQwenApi

echo Test 1: Normal request (non-streaming)
node scripts/inspect/run_tests.js
echo.

echo Test 2: Streaming test
node scripts/inspect/test_streaming.js
echo.

echo Test 3: Interactive chat (type exit to quit)
node scripts/inspect/interactive_chat.js
echo.

echo ╔════════════════════════════════════════╗
echo ║  All tests complete!                   ║
echo ╚════════════════════════════════════════╝
pause
