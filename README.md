# Tim's NHL Player Stats Analyzer

An automated NHL player statistics analyzer that helps you make informed picks for hockey challenges by analyzing multi-season player data, team matchups, and injury reports.

## Features

### 📊 Multi-Season Data Analysis
- **5-Season Historical Data**: Automatically fetches and analyzes player statistics from the last 5 NHL seasons (2021-22 through 2025-26)
- **Aggregated Totals**: Since the NHL API only provides per-season data (not career totals), the script fetches all 5 seasons separately and aggregates them to create 5-year totals
- **Intelligent Caching**: Completed seasons are permanently cached to improve performance and reduce API calls
- **Comprehensive Stats**: Tracks goals, points, shooting percentage, ice time, power play goals, game-winning goals, and plus/minus

### 🎯 Advanced Ranking Methods
Choose from multiple ranking algorithms:
- **Original**: Weighted sum method combining raw stats
- **Z-Score**: Normalizes metrics to standard deviation units
- **Percentile**: Ranks players by percentile within each metric
- **Expected Goals**: Focuses on shot quality and volume
- **Composite**: Combines offensive, efficiency, and usage indices
- **Elo**: Dynamic ratings based on performance scores

### 🏒 Real-Time Game Analysis
- Fetches daily NHL schedules for all teams
- Analyzes team standings and matchup advantages
- Considers home/away factors
- Tracks injured players from ESPN

### 📧 Automated Email Reports
Daily reports include:
- **Top 3 Picks Analysis** for each round with detailed reasoning
- Today's NHL schedule (game times, matchups, venues)
- Complete player statistics table with:
  - Current season stats (2025-26)
  - Previous season stats (2024-25)
  - 5-year totals across all fetched seasons (2021-22 through 2025-26)
  - **Note**: 5-year totals are NOT full career stats for veterans who played before 2021-22
- Visual indicators for recommended picks
- Comprehensive weighting methodology explanation

### 💾 Pick History
- Automatically saves all picks to dated JSON files
- Tracks analysis timestamps and conditions
- Maintains historical record for review

## Configuration

Key settings in `player_stats_analyzer.js`:

```javascript
// Seasons to fetch (last 5 seasons)
const SEASONS_TO_FETCH = [
    '20252026', // 2025-26 (current)
    '20242025', // 2024-25
    '20232024', // 2023-24
    '20222023', // 2022-23
    '20212022'  // 2021-22
];

// Completed seasons (permanently cached)
const COMPLETED_SEASONS = ['20242025', '20232024', '20222023', '20212022'];

// Ranking method to use
const DEFAULT_RANKING_METHOD = 'original'; // or 'zscore', 'percentile', 'expected', 'composite', 'elo'

// Show comparison of all methods
const SHOW_METHOD_COMPARISON = true;

// Save picks to files
const SAVE_PICKS_TO_FILES = true;
```

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment variables** (create `.env` file):
   ```
   EMAIL_USER=your-gmail@gmail.com
   EMAIL_APP_PASSWORD=your-app-specific-password
   EMAIL_RECIPIENTS=recipient1@email.com,recipient2@email.com
   ```

3. **Run manually**:
   ```bash
   node player_stats_analyzer.js
   ```

4. **Set up automated daily runs** (macOS):
   - Copy `com.tims.challenge.plist` to `~/Library/LaunchAgents/`
   - Load the launch agent:
     ```bash
     launchctl load ~/Library/LaunchAgents/com.tims.challenge.plist
     ```

## Data Storage

All data is stored in `~/.tims/`:
- `data/` - Season statistics and team schedules (cached)
- `picks/` - Historical pick data organized by date

### Cache Behavior
- **Completed seasons**: Permanently cached (won't refetch)
- **Current season**: Cached daily (updates each day)
- **Team schedules**: Cached until manually refreshed with `FORCE_REFRESH_SCHEDULES = true`

## How It Works

1. **Data Collection**:
   - **Fetches player statistics from NHL API** for all 5 configured seasons (2021-22 through 2025-26)
     - Each season requires a separate API call (the NHL API only provides per-season data, not career totals)
     - Completed seasons are cached permanently to avoid refetching
     - Current season data is refreshed daily
   - **Aggregates multi-season totals** by summing stats across all 5 seasons for each player
   - Scrapes injury reports from ESPN
   - Downloads team schedules and current standings

2. **Player Analysis**:
   - Applies selected ranking method to calculate scoring probabilities using the aggregated multi-season data
   - Adjusts for team standings and matchup advantages
   - Factors in ice time, shooting efficiency, and recent performance across multiple seasons

3. **Recommendation Generation**:
   - Ranks players by calculated probability
   - Identifies key strengths (elite scoring, high shooting %, ice time, etc.)
   - Provides contextual matchup analysis
   - Displays both current season stats and 5-year aggregated totals
   - Generates clear recommendations with supporting data

4. **Reporting**:
   - Sends formatted HTML email with detailed analysis
   - Includes current season, previous season, and 5-year totals for comparison
   - Saves pick data to JSON for historical tracking
   - Logs comprehensive statistics to console

## Scoring Probability Weights

The default ranking method uses these weights:

| Metric | Weight | Description |
|--------|--------|-------------|
| Goals | 30% | Total goals scored |
| Shots on Goal | 25% | Total shots on goal |
| Shooting % | 20% | Percentage of shots that result in goals |
| Time on Ice | 15% | Average time on ice per game |
| Power Play Goals | 10% | Goals scored during power plays |
| Points Per Game | 10% | Average points scored per game |
| Game Winning Goals | 10% | Goals that were game winners |
| Plus/Minus | 5% | Goal differential while on ice |

Additional adjustments:
- **Same division**: 5% advantage per position difference
- **Different divisions**: 3% advantage per position difference

## Multi-Season Benefits

By analyzing 5 seasons of data (2021-22 through 2025-26):
- **Better Trend Analysis**: Identify consistent performers vs. one-season wonders
- **Injury Recovery Patterns**: See how players perform post-injury across multiple seasons
- **Team Change Impact**: Track player performance across different teams
- **Recent Performance Trends**: Understand 5-year performance patterns
- **Larger Sample Size**: More data points lead to more reliable predictions
- **Context for Current Season**: Compare current performance against recent history

**Important Notes**: 
- The 5-year totals shown are NOT full career statistics. Veterans who played before 2021-22 will have additional career stats not reflected in these totals. The 5-year window provides a relevant recent history window for analysis.
- The NHL Stats API does not provide career totals - it only returns per-season data. This script manually fetches each of the 5 seasons separately and aggregates them to create the 5-year totals you see in the reports.

## Requirements

- Node.js (v16+)
- Gmail account with app-specific password for email reports
- Internet connection for API access

## API Sources

- **Player Stats**: NHL Stats API (`api.nhle.com`)
  - Note: API only provides per-season statistics, not career totals
  - Script fetches 5 separate seasons and aggregates the data
  - Example query: `gameTypeId=2 and seasonId<=20252026 and seasonId>=20252026`
- **Schedules**: NHL Web API (`api-web.nhle.com`)
- **Standings**: NHL Web API
- **Injuries**: ESPN NHL Injuries page (web scraping)
- **Pick Options**: Hockey Challenge Helper

## License

Private use only.
