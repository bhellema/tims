<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
"http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nhl.dailytask</string>

    <key>ProgramArguments</key>
    <array>
        <string>/Users/user/.nvm/versions/node/v23.6.0/bin/node</string>
        <string>/Users/user/junk/nhl/player_stats_analyzer.js</string>
    </array>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>6</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>/tmp/com.ben.dailytask.out</string>

    <key>StandardErrorPath</key>
    <string>/tmp/com.ben.dailytask.err</string>

    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
