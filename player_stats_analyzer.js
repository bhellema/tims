#!/usr/bin/env node

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { format } from 'date-fns';
import puppeteer from 'puppeteer';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Get the directory where the script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from the script's directory
dotenv.config({ path: path.resolve(__dirname, '.env') });

// ============================================================================
// CONFIGURATION - Change these settings to modify ranking behavior
// ============================================================================

// NHL Season Configuration
const CURRENT_SEASON = '20252026'; // Current NHL season (2025-26)
const COMBINE_SEASONS = true; // Set to true to combine 2024-25 and 2025-26 season data

// Seasons that are completed and should be cached permanently (never change)
const COMPLETED_SEASONS = ['20242025']; // Add completed seasons here

// Available ranking methods:
// 'original' - Original weighted sum method (default)
// 'zscore' - Z-Score normalization method
// 'percentile' - Percentile-based ranking method
// 'expected' - Expected goals method
// 'composite' - Composite index method
// 'elo' - Elo-style rating method
const DEFAULT_RANKING_METHOD = 'original';

// Set to true to show comparison of all methods
const SHOW_METHOD_COMPARISON = true;

// Set to true to show detailed method descriptions
const SHOW_METHOD_DESCRIPTIONS = true;

// Set to true to force refresh all team schedules (useful if schedules are outdated)
const FORCE_REFRESH_SCHEDULES = false;

// Set to true to save picks to files in the picks folder
const SAVE_PICKS_TO_FILES = true;

// ============================================================================

const API_URL = 'https://api.nhle.com/stats/rest/en/skater/summary';
const HOME_DIR = path.join(os.homedir(), '.tims');
const DATA_DIR = path.join(HOME_DIR, 'data');
const PICKS_BASE_DIR = path.join(HOME_DIR, 'picks');
let teams;

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(PICKS_BASE_DIR)) {
    fs.mkdirSync(PICKS_BASE_DIR, { recursive: true });
}

function getPlayerDailyStats() {
    return path.join(DATA_DIR, `${format(new Date(), 'yyyy-MM-dd')}-players.json`);
}

function getSeasonStatsFile(seasonId) {
    return path.join(DATA_DIR, `${seasonId}-season-players.json`);
}

function getLatestPlayerDailyStats() {
    const files = fs.readdirSync(DATA_DIR).filter(file => file.endsWith('-players.json'));
    if (files.length === 0) return null;
    files.sort((a, b) => b.localeCompare(a));
    return path.join(DATA_DIR, files[0]);
}

function getPicksDirectory() {
    const todayDir = path.join(PICKS_BASE_DIR, format(new Date(), 'yyyy-MM-dd'));
    if (!fs.existsSync(todayDir)) {
        fs.mkdirSync(todayDir, { recursive: true });
    }
    return todayDir;
}

function getNextPicksFilename() {
    const picksDir = getPicksDirectory();
    let index = 1;
    let filename;
    do {
        filename = path.join(picksDir, `picks_${index}.json`);
        index++;
    } while (fs.existsSync(filename));
    return filename;
}

async function fetchAllTeamSchedules(teams) {
    console.log('Checking team schedules...');

    let schedulesFetched = 0;
    let schedulesSkipped = 0;

    for (const team of teams) {
        const scheduleFile = path.join(DATA_DIR, `${team}-schedule.json`);

        // Skip if schedule file already exists (unless force refresh is enabled)
        if (fs.existsSync(scheduleFile) && !FORCE_REFRESH_SCHEDULES) {
            schedulesSkipped++;
            console.log(`Schedule for ${team} already exists, skipping...`);
            continue;
        }

        console.log(`Fetching schedule for ${team}...`);
        try {
            const response = await fetch(`https://api-web.nhle.com/v1/club-schedule-season/${team}/20252026`);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const scheduleData = await response.json();

            // Write schedule to file
            fs.writeFileSync(scheduleFile, JSON.stringify(scheduleData, null, 2), 'utf8');
            console.log(`Saved schedule for ${team}`);
            schedulesFetched++;

            // Add a small delay between requests to be nice to the API
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            console.error(`Error fetching schedule for ${team}:`, error);
        }
    }

    console.log(`Completed fetching team schedules: ${schedulesFetched} fetched, ${schedulesSkipped} skipped`);
}

async function fetchAllPlayerStats() {
    const todayFile = getPlayerDailyStats();
    const latestFile = getLatestPlayerDailyStats();

    if (latestFile && latestFile === todayFile && fs.existsSync(todayFile)) {
        console.log('Using cached player data from today...');
        const data = JSON.parse(fs.readFileSync(todayFile, 'utf8'));
        teams = data.map(player => player.teamAbbrevs.split(',').pop().trim())
            .filter((team, index, self) => self.indexOf(team) === index)
            .sort();
        return data;
    }

    console.log('Fetching combined player data from 2024-25 and 2025-26 seasons...');

    // Fetch both seasons
    const season202425 = await fetchPlayerStatsForSeason('20242025');
    const season202526 = await fetchPlayerStatsForSeason('20252026');

    // Combine the data
    let allPlayers = [];
    let seasonStats = { '20242025': 0, '20252026': 0 };

    if (season202425 && season202425.length > 0) {
        allPlayers = [...allPlayers, ...season202425];
        seasonStats['20242025'] = season202425.length;
        console.log(`Loaded ${season202425.length} players from 2024-25 season`);
    }

    if (season202526 && season202526.length > 0) {
        allPlayers = [...allPlayers, ...season202526];
        seasonStats['20252026'] = season202526.length;
        console.log(`Loaded ${season202526.length} players from 2025-26 season`);
    }

    if (allPlayers.length === 0) {
        console.error('No player data available for either season');
        return null;
    }

    console.log(`Combined player data: ${seasonStats['20242025']} from 2024-25, ${seasonStats['20252026']} from 2025-26`);
    console.log(`Total players loaded: ${allPlayers.length}`);

    // Show season breakdown for analysis
    if (seasonStats['20242025'] > 0 && seasonStats['20252026'] > 0) {
        console.log(`\n📊 Season Data Breakdown:`);
        console.log(`  2024-25 Season: ${seasonStats['20242025']} players (${((seasonStats['20242025'] / allPlayers.length) * 100).toFixed(1)}%)`);
        console.log(`  2025-26 Season: ${seasonStats['20252026']} players (${((seasonStats['20252026'] / allPlayers.length) * 100).toFixed(1)}%)`);
        console.log(`  Combined dataset provides comprehensive player analysis across both seasons`);
    }

    teams = allPlayers.map(player => player.teamAbbrevs.split(',').pop().trim())
        .filter((team, index, self) => self.indexOf(team) === index)
        .sort();

    fs.writeFileSync(todayFile, JSON.stringify(allPlayers, null, 2), 'utf8');
    return allPlayers;
}

async function fetchPlayerStatsForSeason(seasonId) {
    const seasonFile = getSeasonStatsFile(seasonId);

    // Check if we have cached data for this season
    if (fs.existsSync(seasonFile)) {
        const isCompletedSeason = COMPLETED_SEASONS.includes(seasonId);
        const cacheType = isCompletedSeason ? 'permanent cache' : 'cached data';
        console.log(`Using ${cacheType} for ${seasonId} season...`);
        try {
            const cachedData = JSON.parse(fs.readFileSync(seasonFile, 'utf8'));
            console.log(`Loaded ${cachedData.length} players from ${cacheType} for ${seasonId}`);
            return cachedData;
        } catch (error) {
            console.error(`Error reading cached data for ${seasonId}:`, error);
            // Continue to fetch fresh data if cache is corrupted
        }
    }

    console.log(`Fetching fresh data for ${seasonId} season...`);
    const limit = 100;
    let start = 0;
    let allPlayers = [];
    let hasMoreData = true;

    while (hasMoreData) {
        const params = new URLSearchParams({
            isAggregate: 'false',
            isGame: 'false',
            start: start.toString(),
            limit: limit.toString(),
            cayenneExp: `gameTypeId=2 and seasonId<=${seasonId} and seasonId>=${seasonId}`
        });

        try {
            const response = await fetch(`${API_URL}?${params}`);
            const data = await response.json();
            const players = data.data;

            if (players.length > 0) {
                allPlayers = [...allPlayers, ...players];
                console.log(`Fetched ${players.length} players for ${seasonId} (Total: ${allPlayers.length})`);
                start += limit;
                if (players.length < limit) hasMoreData = false;
            } else {
                hasMoreData = false;
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error(`Error fetching player stats for ${seasonId}:`, error);
            return null;
        }
    }

    // Cache the data for future use
    if (allPlayers.length > 0) {
        try {
            fs.writeFileSync(seasonFile, JSON.stringify(allPlayers, null, 2), 'utf8');
            console.log(`Cached ${allPlayers.length} players for ${seasonId} season`);
        } catch (error) {
            console.error(`Error caching data for ${seasonId}:`, error);
        }
    }

    return allPlayers;
}

async function scrapeInjuredPlayers() {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );

    await page.goto('https://www.espn.com/nhl/injuries', {
        waitUntil: 'networkidle2',
        timeout: 60000
    });

    const injuredPlayers = await page.evaluate(() => {
        const players = [];
        const rows = document.querySelectorAll('.Table__TD > a.AnchorLink');
        rows.forEach(row => {
            players.push({ name: row.textContent, id: row.href.split('/').pop() });
        });
        return players;
    });

    await browser.close();
    return injuredPlayers;
}

async function scrapePlayerNames(injuredPlayers = [], allPlayerStats) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto('https://hockeychallengehelper.com/', { waitUntil: 'networkidle2' });

    const playersInRound = await page.evaluate(() => {
        const tables = document.querySelectorAll('.player-table');
        const picks = [];

        tables.forEach(table => {
            const players = [];
            table.querySelectorAll('tr').forEach(row => {
                const anchor = row.querySelector('a.vertical-middle');
                if (anchor) {
                    const name = anchor.innerText.trim();
                    const url = anchor.href;
                    const idMatch = url.match(/\/player\/(\d+)$/);
                    if (idMatch) {
                        const id = idMatch[1];
                        players.push({ name, id });
                    }
                }
            });
            picks.push(players);
        });

        return picks;
    });
    await browser.close();

    return playersInRound.reduce((acc, round, index) => {
        acc[index] = round.map(player => {
            const fullPlayer = allPlayerStats.find(p => p.playerId == player.id);
            if (fullPlayer && injuredPlayers.map(ip => ip.name).includes(
                fullPlayer.skaterFullName)) {
                console.warn(`🚨 ${fullPlayer.skaterFullName} is injured!`);
                return null;
            }
            return fullPlayer;
        }).filter(Boolean);
        return acc;
    }, [[]]);
}

// Original weighted sum method
function calculateScoringProbability(playerStats) {
    const weights = {
        toi: 0.15,           // Time on Ice Weight
        sog: 0.25,           // Shots on Goal Weight
        shPercent: 0.20,     // Shooting Percentage Weight
        ppGoals: 0.10,       // Power Play Goals Weight
        pointsPerGame: 0.10, // Points Per Game Weight
        plusMinus: 0.05,     // Plus/Minus Weight
        gameWinningGoals: 0.10, // Game Winning Goals Weight
        goals: 0.30          // Total Goals Weight (higher impact)
    };

    // Convert time on ice to minutes
    const toiInMinutes = playerStats.timeOnIcePerGame / 60;

    let scoreProbability =
        (toiInMinutes * weights.toi) +
        (playerStats.shots * weights.sog) +
        (playerStats.shootingPct * 100 * weights.shPercent) + // Convert shooting % to whole number
        (playerStats.ppGoals * weights.ppGoals) +
        (playerStats.pointsPerGame * weights.pointsPerGame) +
        (playerStats.plusMinus * weights.plusMinus) +
        (playerStats.gameWinningGoals * weights.gameWinningGoals) +
        (playerStats.goals * weights.goals);

    // Normalize to a percentage (0-100 scale)
    return Math.min(Math.max(scoreProbability, 0), 100).toFixed(2);
}

// Alternative Method 1: Normalized Z-Score Method
function calculateZScoreMethod(playerStats, allPlayers) {
    const metrics = ['goals', 'shots', 'shootingPct', 'ppGoals', 'pointsPerGame', 'plusMinus', 'gameWinningGoals', 'timeOnIcePerGame'];
    const weights = [0.30, 0.25, 0.20, 0.10, 0.10, 0.05, 0.10, 0.15];

    const normalizedScores = metrics.map(metric => {
        const values = allPlayers.map(p => p[metric]);
        const mean = values.reduce((a, b) => a + b) / values.length;
        const stdDev = Math.sqrt(values.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / values.length);

        if (stdDev === 0) return 0; // Handle case where all values are the same
        return (playerStats[metric] - mean) / stdDev;
    });

    // Apply weights to normalized scores and convert to 0-100 scale
    const weightedScore = normalizedScores.reduce((sum, score, i) => sum + (score * weights[i]), 0);

    // Convert z-score to percentage (assuming normal distribution)
    // Z-score of 0 = 50%, +2 = ~98%, -2 = ~2%
    const percentage = 50 + (weightedScore * 15); // Scale factor of 15 for reasonable range
    return Math.min(Math.max(percentage, 0), 100).toFixed(2);
}

// Alternative Method 2: Percentile-Based Ranking
function calculatePercentileMethod(playerStats, allPlayers) {
    const metrics = ['goals', 'shots', 'shootingPct', 'ppGoals', 'pointsPerGame', 'plusMinus', 'gameWinningGoals', 'timeOnIcePerGame'];
    const weights = [0.30, 0.25, 0.20, 0.10, 0.10, 0.05, 0.10, 0.15];

    const weightedPercentile = metrics.reduce((totalScore, metric, index) => {
        const sortedValues = allPlayers.map(p => p[metric]).sort((a, b) => b - a);
        const playerValue = playerStats[metric];

        // Find percentile (higher values = better percentile)
        const betterCount = sortedValues.filter(val => val > playerValue).length;
        const percentile = ((allPlayers.length - betterCount) / allPlayers.length) * 100;

        return totalScore + (percentile * weights[index]);
    }, 0);

    return Math.min(Math.max(weightedPercentile, 0), 100).toFixed(2);
}

// Alternative Method 3: Expected Goals Based Method
function calculateExpectedGoalsMethod(playerStats) {
    // Approximate expected goals based on shot quality and volume
    const shotQuality = playerStats.shootingPct * 100; // Convert to percentage
    const shotVolume = playerStats.shots;
    const expectedGoals = (shotVolume * shotQuality) / 100;

    // Weight by ice time and recent performance
    const iceTimeFactor = playerStats.timeOnIcePerGame / 60; // Convert to minutes
    const recentForm = playerStats.pointsPerGame;

    // Normalize to 0-100 scale
    const score = (expectedGoals * 0.4) + (iceTimeFactor * 0.3) + (recentForm * 0.3);
    return Math.min(Math.max(score * 2, 0), 100).toFixed(2); // Scale factor of 2 for reasonable range
}

// Alternative Method 4: Composite Index Method
function calculateCompositeIndex(playerStats, allPlayers) {
    // Offensive Index (40% weight)
    const maxGoals = Math.max(...allPlayers.map(p => p.goals));
    const maxPoints = Math.max(...allPlayers.map(p => p.points));
    const maxShootingPct = Math.max(...allPlayers.map(p => p.shootingPct));

    const offensiveIndex = (
        (playerStats.goals / maxGoals) * 0.4 +
        (playerStats.points / maxPoints) * 0.3 +
        (playerStats.shootingPct / maxShootingPct) * 0.3
    ) * 100;

    // Efficiency Index (30% weight)
    const maxPointsPerGame = Math.max(...allPlayers.map(p => p.pointsPerGame));
    const efficiencyIndex = (
        (playerStats.shootingPct * 100) * 0.5 +
        (playerStats.pointsPerGame / maxPointsPerGame) * 0.5
    ) * 100;

    // Usage Index (30% weight)
    const maxTOI = Math.max(...allPlayers.map(p => p.timeOnIcePerGame));
    const maxShots = Math.max(...allPlayers.map(p => p.shots));
    const usageIndex = (
        (playerStats.timeOnIcePerGame / maxTOI) * 0.7 +
        (playerStats.shots / maxShots) * 0.3
    ) * 100;

    const compositeScore = (offensiveIndex * 0.4) + (efficiencyIndex * 0.3) + (usageIndex * 0.3);
    return Math.min(Math.max(compositeScore, 0), 100).toFixed(2);
}

// Alternative Method 5: Elo-Style Rating System
function calculateEloRating(playerStats, allPlayers, baseRating = 1500) {
    const performanceScore = (
        playerStats.goals * 10 +
        (playerStats.points - playerStats.goals) * 7 + // Assists
        playerStats.points * 5 +
        playerStats.shootingPct * 100 * 2 +
        playerStats.plusMinus * 3
    );

    const maxPossibleScore = Math.max(...allPlayers.map(p =>
        p.goals * 10 + (p.points - p.goals) * 7 + p.points * 5 + p.shootingPct * 100 * 2 + p.plusMinus * 3
    ));

    const eloRating = baseRating + ((performanceScore / maxPossibleScore) * 500);

    // Convert Elo rating to percentage (1500 = 50%, 2000 = 100%, 1000 = 0%)
    const percentage = ((eloRating - 1000) / 1000) * 100;
    return Math.min(Math.max(percentage, 0), 100).toFixed(2);
}

// Add this function to calculate team advantage based on standings
function calculateTeamAdvantage(playerTeam, opposingTeam, standings) {
    // Find the divisions and positions of both teams
    let playerTeamRank = null;
    let opposingTeamRank = null;
    let playerDivision = null;
    let opposingDivision = null;

    for (const [division, teams] of Object.entries(standings)) {
        const playerIdx = teams.findIndex(t => t.name === playerTeam);
        const opposingIdx = teams.findIndex(t => t.name === opposingTeam);

        if (playerIdx !== -1) {
            playerTeamRank = playerIdx + 1;
            playerDivision = division;
        }
        if (opposingIdx !== -1) {
            opposingTeamRank = opposingIdx + 1;
            opposingDivision = division;
        }
    }

    // Calculate advantage based on ranking difference
    // Teams in better positions get a positive adjustment
    if (playerTeamRank && opposingTeamRank) {
        // If teams are in the same division, direct comparison
        if (playerDivision === opposingDivision) {
            return (opposingTeamRank - playerTeamRank) * 0.05; // 5% advantage per position difference
        } else {
            // For teams in different divisions, compare relative positions
            return (opposingTeamRank - playerTeamRank) * 0.03; // 3% advantage per position difference
        }
    }
    return 0;
}

// Enhanced analyzePlayer function with multiple ranking methods
function analyzePlayer(playerStats, todaysGames, standings, allPlayers, method = 'original') {
    let prob;

    // Calculate probability using selected method
    switch (method) {
        case 'zscore':
            prob = calculateZScoreMethod(playerStats, allPlayers);
            break;
        case 'percentile':
            prob = calculatePercentileMethod(playerStats, allPlayers);
            break;
        case 'expected':
            prob = calculateExpectedGoalsMethod(playerStats);
            break;
        case 'composite':
            prob = calculateCompositeIndex(playerStats, allPlayers);
            break;
        case 'elo':
            prob = calculateEloRating(playerStats, allPlayers);
            break;
        default:
            prob = calculateScoringProbability(playerStats);
    }

    // Find if the player's team is playing today
    const playerTeam = playerStats.teamAbbrevs.split(',').pop().trim();
    const game = todaysGames.find(g =>
        g.homeTeam === playerTeam || g.awayTeam === playerTeam
    );

    if (game) {
        const opposingTeam = game.homeTeam === playerTeam ? game.awayTeam : game.homeTeam;
        const teamAdvantage = calculateTeamAdvantage(playerTeam, opposingTeam, standings);

        // Adjust probability based on team advantage
        prob = parseFloat(prob) * (1 + teamAdvantage);

        // Ensure probability stays within 0-100 range
        prob = Math.min(Math.max(prob, 0), 100).toFixed(2);
    }

    return {
        name: playerStats.skaterFullName,
        team: playerTeam,
        position: playerStats.positionCode,
        prob,
        method,
        stats: {
            goals: playerStats.goals,
            plusMinus: playerStats.plusMinus,
            gamesPlayed: playerStats.gamesPlayed,
            points: playerStats.points,
            team: playerStats.teamAbbrevs,
            toi: playerStats.timeOnIcePerGame,
            seasonId: playerStats.seasonId
        }
    };
}

async function sendEmailReport(rounds, finalChoices, todaysGames, standings, allPlayerStats) {
    // Create a transporter using Gmail
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_APP_PASSWORD
        }
    });

    // Get recipients from env and split into array
    const recipients = process.env.EMAIL_RECIPIENTS.split(',').map(email => email.trim());

    // Build the email content
    let emailContent = '<h2>Tim\'s Player Analysis Report</h2>\n\n';

    // Add daily schedule section
    emailContent += '<h3>Today\'s NHL Schedule</h3>\n';
    if (todaysGames.length > 0) {
        emailContent += '<table border="1" style="border-collapse: collapse; width: 100%; margin-bottom: 20px;">\n';
        emailContent += '<tr><th>Time</th><th>Matchup</th><th>Venue</th></tr>\n';
        todaysGames.forEach(game => {
            emailContent += `<tr>
                <td>${game.startTime}</td>
                <td>${game.awayTeam} @ ${game.homeTeam}</td>
                <td>${game.venue}</td>
            </tr>\n`;
        });
        emailContent += '</table>\n\n';
    } else {
        emailContent += '<p>No games scheduled for today.</p>\n\n';
    }

    rounds.forEach((round, roundIndex) => {
        emailContent += `<h3>Round ${roundIndex + 1}</h3>\n`;

        // Add detailed analysis for top 3 players
        emailContent += '<h4>Top Picks Analysis</h4>\n';
        emailContent += '<div style="margin-bottom: 20px;">\n';

        // Get top 3 players
        const top3 = round.slice(0, 3);
        top3.forEach((player, index) => {
            const game = todaysGames.find(g =>
                g.homeTeam === player.team || g.awayTeam === player.team
            );

            // Calculate TOI
            const avgTOIMinutes = Math.floor(player.stats.toi / 60);
            const avgTOISeconds = Math.round(player.stats.toi % 60);

            let reasoning = '';
            if (game) {
                const isHome = game.homeTeam === player.team;
                const opponent = isHome ? game.awayTeam : game.homeTeam;

                // Get team standings info
                let teamStanding = null;
                let oppStanding = null;
                let teamDivision = null;

                if (standings) {
                    for (const [division, teams] of Object.entries(standings)) {
                        const teamIdx = teams.findIndex(t => t.name === player.team);
                        const oppIdx = teams.findIndex(t => t.name === opponent);
                        if (teamIdx !== -1) {
                            teamStanding = teamIdx + 1;
                            teamDivision = division;
                        }
                        if (oppIdx !== -1) {
                            oppStanding = oppIdx + 1;
                        }
                    }

                    // Debug: Show team name matching issues
                    if (!teamStanding || !oppStanding) {
                        console.log(`Debug - Team name matching for ${player.name}:`);
                        console.log(`  Player team: "${player.team}"`);
                        console.log(`  Opponent: "${opponent}"`);
                        console.log(`  Available team names in standings:`, Object.values(standings).flat().map(t => t.name));
                    }
                } else {
                    console.log('Standings data is null - team standings will not be available');
                }

                reasoning = `
                    <strong>${index + 1}. ${player.name} (${player.position} - ${player.team}) - ${player.prob}%</strong><br>
                    <ul>
                        <li>Position: ${getFullPosition(player.position)}</li>
                        <li>Season Performance: ${player.stats.goals} goals, ${player.stats.points} points in ${player.stats.gamesPlayed} games</li>
                        <li>Average ice time per game: ${avgTOIMinutes}:${avgTOISeconds.toString().padStart(2, '0')}</li>
                        <li>Playing ${isHome ? 'home' : 'away'} against ${opponent}</li>
                        <li>Team standing: ${teamStanding ? teamStanding + getOrdinalSuffix(teamStanding) + ' in ' + teamDivision : 'Not available'}</li>
                        <li>Opponent standing: ${oppStanding ? oppStanding + getOrdinalSuffix(oppStanding) + ' in their division' : 'Not available'}</li>
                        <li>Plus/Minus: ${player.stats.plusMinus > 0 ? '+' : ''}${player.stats.plusMinus}</li>
                    </ul>
                `;
            } else {
                reasoning = `
                    <strong>${index + 1}. ${player.name} (${player.position} - ${player.team}) - ${player.prob}%</strong><br>
                    <ul>
                        <li>Position: ${getFullPosition(player.position)}</li>
                        <li>No game scheduled for today</li>
                        <li>Season stats: ${player.stats.goals} goals, ${player.stats.points} points in ${player.stats.gamesPlayed} games</li>
                        <li>Average ice time per game: ${avgTOIMinutes}:${avgTOISeconds.toString().padStart(2, '0')}</li>
                    </ul>
                `;
            }
            emailContent += reasoning;
        });

        emailContent += '</div>\n';

        // Add the full round table
        emailContent += '<h4>All Players in Round</h4>\n';
        emailContent += '<table border="1" style="border-collapse: collapse; width: 100%;">\n';
        emailContent += '<tr><th>Rank</th><th>Player</th><th>Pos</th><th>Probability</th><th>Goals (24-25)</th><th>Goals (25-26)</th><th>Points (24-25)</th><th>Points (25-26)</th><th>Games (24-25)</th><th>Games (25-26)</th><th>+/- (24-25)</th><th>+/- (25-26)</th><th>Avg TOI (24-25)</th><th>Avg TOI (25-26)</th><th>Team</th></tr>\n';

        round.forEach((player, index) => {
            // Get season-specific stats for this player
            const seasonStats = getPlayerSeasonStats(player, allPlayerStats);

            // Format TOI for both seasons
            const toi202425 = seasonStats['20242025'].toi;
            const toi202526 = seasonStats['20252026'].toi;
            const toi202425Formatted = toi202425 > 0 ? `${Math.floor(toi202425 / 60)}:${Math.round(toi202425 % 60).toString().padStart(2, '0')}` : '-';
            const toi202526Formatted = toi202526 > 0 ? `${Math.floor(toi202526 / 60)}:${Math.round(toi202526 % 60).toString().padStart(2, '0')}` : '-';

            // Add yellow background for the top pick
            const backgroundColor = index === 0 ? ' style="background-color: #FFEB3B;"' : '';

            emailContent += `<tr${backgroundColor}>
                <td>${index + 1}</td>
                <td>${player.name}</td>
                <td>${player.position}</td>
                <td>${player.prob}%</td>
                <td>${seasonStats['20242025'].goals || '-'}</td>
                <td>${seasonStats['20252026'].goals || '-'}</td>
                <td>${seasonStats['20242025'].points || '-'}</td>
                <td>${seasonStats['20252026'].points || '-'}</td>
                <td>${seasonStats['20242025'].gamesPlayed || '-'}</td>
                <td>${seasonStats['20252026'].gamesPlayed || '-'}</td>
                <td>${seasonStats['20242025'].plusMinus || '-'}</td>
                <td>${seasonStats['20252026'].plusMinus || '-'}</td>
                <td>${toi202425Formatted}</td>
                <td>${toi202526Formatted}</td>
                <td>${player.team}</td>
            </tr>\n`;
        });

        emailContent += '</table>\n\n';
    });

    emailContent += '<h3>Final Choices</h3>\n';
    emailContent += '<ul>\n';
    finalChoices.forEach((choice, index) => {
        emailContent += `<li>Round ${index + 1}: ${choice}</li>\n`;
    });
    emailContent += '</ul>';

    // Add weighting rules section at the bottom
    emailContent += `
        <hr style="margin-top: 30px;">
        <div style="font-size: 0.8em; color: #666;">
            <h4>Player Scoring Probability Weighting Rules:</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">
                <tr>
                    <th style="text-align: left; padding: 4px;">Metric</th>
                    <th style="text-align: left; padding: 4px;">Weight</th>
                    <th style="text-align: left; padding: 4px;">Description</th>
                </tr>
                <tr>
                    <td style="padding: 4px;">Goals</td>
                    <td style="padding: 4px;">30%</td>
                    <td style="padding: 4px;">Total goals scored this season</td>
                </tr>
                <tr>
                    <td style="padding: 4px;">Shots on Goal</td>
                    <td style="padding: 4px;">25%</td>
                    <td style="padding: 4px;">Total shots on goal</td>
                </tr>
                <tr>
                    <td style="padding: 4px;">Shooting Percentage</td>
                    <td style="padding: 4px;">20%</td>
                    <td style="padding: 4px;">Percentage of shots that result in goals</td>
                </tr>
                <tr>
                    <td style="padding: 4px;">Time on Ice</td>
                    <td style="padding: 4px;">15%</td>
                    <td style="padding: 4px;">Average time on ice per game</td>
                </tr>
                <tr>
                    <td style="padding: 4px;">Power Play Goals</td>
                    <td style="padding: 4px;">10%</td>
                    <td style="padding: 4px;">Goals scored during power plays</td>
                </tr>
                <tr>
                    <td style="padding: 4px;">Points Per Game</td>
                    <td style="padding: 4px;">10%</td>
                    <td style="padding: 4px;">Average points scored per game</td>
                </tr>
                <tr>
                    <td style="padding: 4px;">Game Winning Goals</td>
                    <td style="padding: 4px;">10%</td>
                    <td style="padding: 4px;">Goals that were game winners</td>
                </tr>
                <tr>
                    <td style="padding: 4px;">Plus/Minus</td>
                    <td style="padding: 4px;">5%</td>
                    <td style="padding: 4px;">Goal differential while on ice at even strength</td>
                </tr>
            </table>

            <h4 style="margin-top: 15px;">Additional Adjustments:</h4>
            <ul style="margin-top: 5px;">
                <li>Teams in better standings positions receive an advantage when playing against lower-ranked teams:
                    <ul>
                        <li>Same division: 5% advantage per position difference</li>
                        <li>Different divisions: 3% advantage per position difference</li>
                    </ul>
                </li>
                <li>All probabilities are normalized to ensure they stay within a 0-100% range</li>
                <li>Players marked as injured are automatically excluded from consideration</li>
            </ul>

            <p style="font-style: italic; margin-top: 15px;">
                Note: These weights and adjustments are used to calculate the final probability score for each player. 
                The actual likelihood of scoring may vary based on additional factors not captured in this model.
            </p>
        </div>
    `;

    // Configure email options
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: recipients,
        subject: `NHL Player Analysis Report - ${format(new Date(), 'yyyy-MM-dd')}`,
        html: emailContent
    };

    // Send the email
    try {
        await transporter.sendMail(mailOptions);
        console.log('Analysis report email sent successfully');
    } catch (error) {
        console.error('Error sending email:', error);
    }
}

// Helper function to get season-specific stats for a player
function getPlayerSeasonStats(player, allPlayerStats) {
    const seasonStats = {
        '20242025': { goals: 0, points: 0, gamesPlayed: 0, plusMinus: 0, toi: 0 },
        '20252026': { goals: 0, points: 0, gamesPlayed: 0, plusMinus: 0, toi: 0 }
    };

    // The player object from analysisResults has a different structure
    // We need to find the original player data by matching name and team
    const playerName = player.name;
    const playerTeam = player.team;

    // Find all instances of this player across both seasons by matching name and team
    const playerInstances = allPlayerStats.filter(p => {
        const pName = p.skaterFullName;
        const pTeam = p.teamAbbrevs.split(',').pop().trim();
        return pName === playerName && pTeam === playerTeam;
    });

    playerInstances.forEach(instance => {
        const season = instance.seasonId.toString(); // Convert to string to match object keys

        if (seasonStats[season]) {
            seasonStats[season].goals = instance.goals || 0;
            seasonStats[season].points = instance.points || 0;
            seasonStats[season].gamesPlayed = instance.gamesPlayed || 0;
            seasonStats[season].plusMinus = instance.plusMinus || 0;
            seasonStats[season].toi = instance.timeOnIcePerGame || 0;
        }
    });

    return seasonStats;
}

// Helper function for ordinal suffixes
function getOrdinalSuffix(num) {
    const j = num % 10;
    const k = num % 100;
    if (j == 1 && k != 11) {
        return "st";
    }
    if (j == 2 && k != 12) {
        return "nd";
    }
    if (j == 3 && k != 13) {
        return "rd";
    }
    return "th";
}

async function getTodaysStandings() {
    const today = format(new Date(), 'yyyy-MM-dd');
    console.log(`Fetching standings for ${today}...`);

    try {
        // Try current season standings first, then fallback to previous season
        let response = await fetch(`https://api-web.nhle.com/v1/standings/${today}`);

        if (!response.ok) {
            console.log('Current season standings not available, trying previous season...');
            // Fallback to previous season if current season data isn't available yet
            response = await fetch(`https://api-web.nhle.com/v1/standings/2024-10-01`);
        }
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Group teams by division
        const divisionStandings = data.standings.reduce((acc, team) => {
            const divName = team.divisionName;
            if (!acc[divName]) {
                acc[divName] = [];
            }
            acc[divName].push({
                name: team.teamAbbrev.default,
                points: team.points,
                gamesPlayed: team.gamesPlayed
            });
            return acc;
        }, {});

        // Sort teams in each division by points (and games played as tiebreaker)
        for (const division in divisionStandings) {
            divisionStandings[division].sort((a, b) => {
                if (b.points !== a.points) {
                    return b.points - a.points;
                }
                return a.gamesPlayed - b.gamesPlayed;
            });
        }

        console.log('Standings fetched successfully:');
        console.log(`- Divisions: ${Object.keys(divisionStandings).join(', ')}`);
        console.log(`- Total teams: ${data.standings.length}`);

        return divisionStandings;
    } catch (error) {
        console.error('Error fetching standings:', error);
        console.log('Standings will not be available in the report');
        return null;
    }
}

function getTodaysGames() {
    console.log('Checking for today\'s games...');

    const today = format(new Date(), 'yyyy-MM-dd');
    console.log(`Looking for games on: ${today}`);
    const games = new Map(); // Using Map to avoid duplicate games

    // Read all schedule files from the data directory
    const scheduleFiles = fs.readdirSync(DATA_DIR)
        .filter(file => file.endsWith('-schedule.json'));

    console.log(`Found ${scheduleFiles.length} schedule files to check`);

    for (const file of scheduleFiles) {
        try {
            const scheduleData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));

            // Look through the games array in the schedule
            for (const game of scheduleData.games) {
                const gameDate = game.gameDate.split('T')[0]; // Extract just the date part

                if (gameDate === today) {
                    const gameKey = `${game.homeTeam.abbrev}-${game.awayTeam.abbrev}`;
                    if (!games.has(gameKey)) {
                        // Convert game time to Eastern Time
                        const gameDateTime = new Date(game.startTimeUTC);
                        const easternTime = gameDateTime.toLocaleTimeString('en-US', {
                            timeZone: 'America/Toronto',
                            hour: 'numeric',
                            minute: '2-digit',
                            hour12: true
                        });

                        games.set(gameKey, {
                            homeTeam: game.homeTeam.abbrev,
                            awayTeam: game.awayTeam.abbrev,
                            startTime: easternTime,
                            venue: game.venue.default
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`Error reading schedule file ${file}:`, error.message);
        }
    }

    const todaysGames = Array.from(games.values());

    // Sort games by start time
    todaysGames.sort((a, b) => {
        const timeA = new Date(`1970-01-01 ${a.startTime}`);
        const timeB = new Date(`1970-01-01 ${b.startTime}`);
        return timeA - timeB;
    });

    if (todaysGames.length === 0) {
        console.log('No games scheduled for today.');
        console.log('Debug info:');
        console.log(`- Today's date: ${today}`);
        console.log(`- Schedule files found: ${scheduleFiles.length}`);
        if (scheduleFiles.length === 0) {
            console.log('- No schedule files found in data directory');
            console.log(`- Data directory: ${DATA_DIR}`);
        } else {
            console.log('- Schedule files exist but no games found for today');
            console.log('- This could mean:');
            console.log('  * No NHL games are scheduled for today');
            console.log('  * The schedule files are outdated');
            console.log('  * There\'s an issue with the date format matching');
        }
    } else {
        console.log(`\nGames scheduled for ${today} (Eastern Time):`);
        console.log('------------------------');
        todaysGames.forEach(game => {
            console.log(`${game.awayTeam} @ ${game.homeTeam} - ${game.startTime} ET`);
            console.log(`Venue: ${game.venue}`);
            console.log('------------------------');
        });
    }

    return todaysGames;
}

function analyzeGoalsAndTOI(allPlayerStats) {
    // Create array of players with their goals and TOI
    const playerStats = allPlayerStats.map(player => {
        const totalTOIMinutes = (player.timeOnIcePerGame * player.gamesPlayed) / 60;
        return {
            name: player.skaterFullName,
            team: player.teamAbbrevs.split(',').pop().trim(),
            goals: player.goals,
            gamesPlayed: player.gamesPlayed,
            totalTOI: totalTOIMinutes,
            goalsPerHour: (player.goals / totalTOIMinutes) * 60,
            averageTOIPerGame: player.timeOnIcePerGame / 60
        };
    });

    // Sort by goals in descending order
    playerStats.sort((a, b) => b.goals - a.goals);

    console.log('\nPlayer Goals and Ice Time Analysis');
    console.log('=================================');
    console.log('Top 20 Goal Scorers:');
    console.log('Name\t\tTeam\tGoals\tGames\tAvg TOI\tTotal TOI\tGoals/Hour');
    console.log('----------------------------------------------------------------');

    playerStats.slice(0, 20).forEach(player => {
        console.log(
            `${player.name.padEnd(20)}${player.team.padEnd(8)}${player.goals.toString().padStart(4)}${player.gamesPlayed.toString().padStart(8)}${player.averageTOIPerGame.toFixed(1).padStart(8)}${player.totalTOI.toFixed(1).padStart(12)}${player.goalsPerHour.toFixed(2).padStart(12)}`
        );
    });

    // Calculate correlation coefficient between TOI and goals
    const totalTOIs = playerStats.map(p => p.totalTOI);
    const goals = playerStats.map(p => p.goals);
    const correlation = calculateCorrelation(totalTOIs, goals);

    console.log('\nStatistical Analysis:');
    console.log(`Correlation coefficient between Total TOI and Goals: ${isNaN(correlation) ? 'NaN (check data)' : correlation.toFixed(3)}`);

    // Debug information if correlation is NaN
    if (isNaN(correlation)) {
        console.log('Debug info:');
        console.log(`- Number of players: ${playerStats.length}`);
        console.log(`- TOI range: ${Math.min(...totalTOIs).toFixed(1)} - ${Math.max(...totalTOIs).toFixed(1)}`);
        console.log(`- Goals range: ${Math.min(...goals)} - ${Math.max(...goals)}`);
        console.log(`- TOI variance: ${totalTOIs.every(val => val === totalTOIs[0]) ? 'Zero (all same)' : 'Non-zero'}`);
        console.log(`- Goals variance: ${goals.every(val => val === goals[0]) ? 'Zero (all same)' : 'Non-zero'}`);
    }

    // Find players with highest goals per hour (minimum 5 games played)
    const efficientScorers = [...playerStats]
        .filter(p => p.gamesPlayed >= 5)
        .sort((a, b) => b.goalsPerHour - a.goalsPerHour);

    console.log('\nTop 10 Most Efficient Scorers (min. 5 games):');
    console.log('Name\t\tTeam\tGoals\tGames\tAvg TOI\tGoals/Hour');
    console.log('----------------------------------------------------------------');

    efficientScorers.slice(0, 10).forEach(player => {
        console.log(
            `${player.name.padEnd(20)}${player.team.padEnd(8)}${player.goals.toString().padStart(4)}${player.gamesPlayed.toString().padStart(8)}${player.averageTOIPerGame.toFixed(1).padStart(8)}${player.goalsPerHour.toFixed(2).padStart(12)}`
        );
    });

    return { playerStats, correlation };
}

// Helper function to calculate correlation coefficient (Pearson's r)
function calculateCorrelation(x, y) {
    const n = x.length;

    // Check if arrays have the same length
    if (n !== y.length || n === 0) {
        return NaN;
    }

    // Calculate means
    const meanX = x.reduce((sum, val) => sum + val, 0) / n;
    const meanY = y.reduce((sum, val) => sum + val, 0) / n;

    // Calculate numerator: sum of (x - meanX) * (y - meanY)
    let numerator = 0;
    for (let i = 0; i < n; i++) {
        numerator += (x[i] - meanX) * (y[i] - meanY);
    }

    // Calculate denominators: sum of squared deviations
    let sumSquaredDevX = 0;
    let sumSquaredDevY = 0;
    for (let i = 0; i < n; i++) {
        sumSquaredDevX += Math.pow(x[i] - meanX, 2);
        sumSquaredDevY += Math.pow(y[i] - meanY, 2);
    }

    // Check for zero variance (all values are the same)
    if (sumSquaredDevX === 0 || sumSquaredDevY === 0) {
        return NaN; // Cannot calculate correlation when variance is zero
    }

    // Calculate Pearson correlation coefficient
    const correlation = numerator / Math.sqrt(sumSquaredDevX * sumSquaredDevY);

    return correlation;
}

// Helper function to convert position codes to full names
function getFullPosition(positionCode) {
    const positions = {
        'L': 'Left Wing',
        'C': 'Center',
        'R': 'Right Wing',
        'D': 'Defense'
    };
    return positions[positionCode] || positionCode;
}

// Function to get ranking method description
function getRankingMethodDescription(method) {
    const descriptions = {
        'original': 'Original weighted sum method - combines raw stats with fixed weights',
        'zscore': 'Z-Score normalization - normalizes each metric to standard deviation units',
        'percentile': 'Percentile-based ranking - ranks players by percentile within each metric',
        'expected': 'Expected goals method - focuses on shot quality and volume',
        'composite': 'Composite index - combines offensive, efficiency, and usage indices',
        'elo': 'Elo-style rating - creates dynamic ratings based on performance scores'
    };
    return descriptions[method] || 'Unknown method';
}

// Function to analyze ranking method differences
function analyzeRankingDifferences(playerAnalysis, method1, method2) {
    console.log(`\n=== COMPARING ${method1.toUpperCase()} vs ${method2.toUpperCase()} ===`);

    const method1Results = playerAnalysis.filter(p => p.method === method1).sort((a, b) => b.prob - a.prob);
    const method2Results = playerAnalysis.filter(p => p.method === method2).sort((a, b) => b.prob - a.prob);

    console.log(`Top 3 differences:`);
    for (let i = 0; i < Math.min(3, method1Results.length); i++) {
        const player1 = method1Results[i];
        const player2 = method2Results[i];
        const diff = (parseFloat(player1.prob) - parseFloat(player2.prob)).toFixed(2);
        console.log(`${player1.name}: ${method1}=${player1.prob}%, ${method2}=${player2.prob}% (diff: ${diff}%)`);
    }
}

// Function to save picks to file
async function savePicksToFile(analysisResults, finalChoice, todaysGames, standings) {
    try {
        const picksFilename = getNextPicksFilename();

        const picksData = {
            timestamp: new Date().toISOString(),
            date: format(new Date(), 'yyyy-MM-dd'),
            todaysGames: todaysGames,
            standings: standings,
            finalChoices: finalChoice,
            detailedAnalysis: analysisResults.map((round, index) => ({
                round: index + 1,
                players: round.map(player => ({
                    name: player.name,
                    team: player.team,
                    position: player.position,
                    probability: player.prob,
                    method: player.method,
                    stats: player.stats
                }))
            })),
            summary: {
                totalRounds: analysisResults.length,
                totalPlayersAnalyzed: analysisResults.reduce((sum, round) => sum + round.length, 0),
                rankingMethod: DEFAULT_RANKING_METHOD,
                gamesToday: todaysGames.length
            }
        };

        fs.writeFileSync(picksFilename, JSON.stringify(picksData, null, 2), 'utf8');
        console.log(`\nPicks saved to: ${picksFilename}`);

    } catch (error) {
        console.error('Error saving picks to file:', error);
    }
}

// Function to show season cache status
function showSeasonCacheStatus() {
    console.log('\n=== SEASON CACHE STATUS ===');

    const seasonsToCheck = ['20242025', '20252026'];

    seasonsToCheck.forEach(seasonId => {
        const seasonFile = getSeasonStatsFile(seasonId);
        const isCompleted = COMPLETED_SEASONS.includes(seasonId);
        const exists = fs.existsSync(seasonFile);

        if (exists) {
            try {
                const stats = fs.statSync(seasonFile);
                const sizeKB = (stats.size / 1024).toFixed(1);
                const cacheType = isCompleted ? 'permanent' : 'temporary';
                console.log(`${seasonId}: ✅ Cached (${sizeKB} KB, ${cacheType})`);
            } catch (error) {
                console.log(`${seasonId}: ❌ Cache corrupted`);
            }
        } else {
            console.log(`${seasonId}: ⏳ Not cached (will fetch fresh)`);
        }
    });

    console.log('===========================\n');
}

// Function to list existing picks files
function listExistingPicks() {
    try {
        if (!fs.existsSync(PICKS_BASE_DIR)) {
            console.log('No picks directory found.');
            return;
        }

        const dateDirs = fs.readdirSync(PICKS_BASE_DIR, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
            .sort((a, b) => b.localeCompare(a)); // Sort newest first

        if (dateDirs.length === 0) {
            console.log('No picks files found.');
            return;
        }

        console.log('\n=== EXISTING PICKS FILES ===');
        dateDirs.forEach(dateDir => {
            const datePath = path.join(PICKS_BASE_DIR, dateDir);
            const picksFiles = fs.readdirSync(datePath)
                .filter(file => file.endsWith('.json'))
                .sort();

            console.log(`\n${dateDir}:`);
            picksFiles.forEach(file => {
                const filePath = path.join(datePath, file);
                const stats = fs.statSync(filePath);
                console.log(`  ${file} (${stats.size} bytes, ${stats.mtime.toLocaleString()})`);
            });
        });
        console.log('============================\n');

    } catch (error) {
        console.error('Error listing picks files:', error);
    }
}

async function main() {
    console.log('Initializing NHL player stats analyzer...');

    // Show season cache status
    showSeasonCacheStatus();

    // List existing picks files
    listExistingPicks();

    const allPlayerStats = await fetchAllPlayerStats();

    if (!allPlayerStats) {
        console.log('Failed to fetch player stats. Exiting...');
        return;
    }

    // Add the TOI analysis
    const toiAnalysis = analyzeGoalsAndTOI(allPlayerStats);

    const teams = allPlayerStats.map(player => player.teamAbbrevs.split(',').pop().trim())
        .filter((team, index, self) => self.indexOf(team) === index)
        .sort();

    await fetchAllTeamSchedules(teams);
    const todaysGames = getTodaysGames();
    const standings = await getTodaysStandings();

    const injuredPlayers = await scrapeInjuredPlayers();
    const pickRounds = await scrapePlayerNames(injuredPlayers, allPlayerStats);

    const finalChoice = [];
    const analysisResults = [];

    // Define available ranking methods
    const rankingMethods = ['original', 'zscore', 'percentile', 'expected', 'composite', 'elo'];

    // Show method descriptions if enabled
    if (SHOW_METHOD_DESCRIPTIONS) {
        console.log('\n=== AVAILABLE RANKING METHODS ===');
        rankingMethods.forEach(method => {
            console.log(`${method.toUpperCase()}: ${getRankingMethodDescription(method)}`);
        });
        console.log('================================\n');
    }

    // Compare all methods for the first round (if available)
    if (SHOW_METHOD_COMPARISON && pickRounds.length > 0 && pickRounds[0].length > 0) {
        console.log('\n=== RANKING METHOD COMPARISON ===');
        console.log('Comparing top 5 players using different ranking methods:\n');

        const topPlayers = pickRounds[0].slice(0, 5);

        rankingMethods.forEach(method => {
            console.log(`\n--- ${method.toUpperCase()} METHOD ---`);
            const methodAnalysis = topPlayers.map(player =>
                analyzePlayer(player, todaysGames, standings, allPlayerStats, method)
            );
            methodAnalysis.sort((a, b) => b.prob - a.prob);

            methodAnalysis.forEach((player, index) => {
                console.log(`${index + 1}. ${player.name} (${player.team}) - ${player.prob}%`);
            });
        });
        console.log('\n================================\n');
    }

    // Use the configured method for final analysis
    const selectedMethod = DEFAULT_RANKING_METHOD;

    pickRounds.forEach((picks, roundIndex) => {
        const playerAnalysis = [];

        picks.forEach(player => {
            playerAnalysis.push(analyzePlayer(player, todaysGames, standings, allPlayerStats, selectedMethod));
        });

        playerAnalysis.sort((a, b) => b.prob - a.prob);

        console.log(`Round ${roundIndex + 1} (using ${selectedMethod} method):`);
        playerAnalysis.forEach((player, index) => {
            console.log(`${index + 1}. ${player.name} (${player.team}) - ${player.prob}%`);
        });

        if (playerAnalysis.length > 0) {
            finalChoice.push(playerAnalysis[0].name);
        }

        analysisResults.push(playerAnalysis);
        console.log('\n');
    });

    finalChoice.forEach((choice, index) => {
        console.log(`Round ${index + 1}: ${choice}`);
    });

    // Save picks to file (if enabled)
    if (SAVE_PICKS_TO_FILES) {
        await savePicksToFile(analysisResults, finalChoice, todaysGames, standings);
    }

    // Send email report with additional data
    await sendEmailReport(analysisResults, finalChoice, todaysGames, standings, allPlayerStats);
}

main();
