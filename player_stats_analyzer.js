#!/usr/bin/env node

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {format} from 'date-fns';
import puppeteer from 'puppeteer';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Get the directory where the script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from the script's directory
dotenv.config({ path: path.resolve(__dirname, '.env') });

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
    
    for (const team of teams) {
        const scheduleFile = path.join(DATA_DIR, `${team}-schedule.json`);
        
        // Skip if schedule file already exists
        if (fs.existsSync(scheduleFile)) {
            continue;
        }

        console.log(`Fetching schedule for ${team}...`);
        try {
            const response = await fetch(`https://api-web.nhle.com/v1/club-schedule-season/${team}/20242025`);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const scheduleData = await response.json();
            
            // Write schedule to file
            fs.writeFileSync(scheduleFile, JSON.stringify(scheduleData, null, 2), 'utf8');
            console.log(`Saved schedule for ${team}`);
            
            // Add a small delay between requests to be nice to the API
            await new Promise(resolve => setTimeout(resolve, 100));
            
        } catch (error) {
            console.error(`Error fetching schedule for ${team}:`, error);
        }
    }
    
    console.log('Completed fetching team schedules');
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

    console.log('Fetching new player data...');
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
            cayenneExp: 'gameTypeId=2 and seasonId<=20242025 and seasonId>=20242025'
        });

        try {
            const response = await fetch(`${API_URL}?${params}`);
            const data = await response.json();
            const players = data.data;

            if (players.length > 0) {
                allPlayers = [...allPlayers, ...players];
                console.log(`Fetched ${players.length} players (Total: ${allPlayers.length})`);
                start += limit;
                if (players.length < limit) hasMoreData = false;
            } else {
                hasMoreData = false;
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error('Error fetching player stats:', error);
            return null;
        }
    }

    teams = data.map(player => player.teamAbbrevs.split(',').pop().trim())
        .filter((team, index, self) => self.indexOf(team) === index)
        .sort();

    fs.writeFileSync(todayFile, JSON.stringify(allPlayers, null, 2), 'utf8');
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
            players.push({name: row.textContent, id: row.href.split('/').pop()});
        });
        return players;
    });

    await browser.close();
    return injuredPlayers;
}

async function scrapePlayerNames(injuredPlayers = [], allPlayerStats) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto('https://hockeychallengehelper.com/', {waitUntil: 'networkidle2'});

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

// Modify the analyzePlayer function to include team advantage
function analyzePlayer(playerStats, todaysGames, standings) {
    let prob = calculateScoringProbability(playerStats);
    
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
        prob,
        stats: {
            goals: playerStats.goals,
            plusMinus: playerStats.plusMinus,
            gamesPlayed: playerStats.gamesPlayed,
            points: playerStats.points,
            team: playerStats.teamAbbrevs,
            toi: playerStats.timeOnIcePerGame
        }
    };
}

async function sendEmailReport(rounds, finalChoices, todaysGames, standings) {
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
    let emailContent = '<h2>NHL Player Analysis Report</h2>\n\n';
    
    rounds.forEach((round, roundIndex) => {
        emailContent += `<h3>Round ${roundIndex + 1}</h3>\n`;
        
        // Add detailed analysis for top 3 players
        emailContent += '<h4>Top Picks Analysis</h4>\n';
        emailContent += '<div style="margin-bottom: 20px;">\n';
        
        // Get top 3 players
        const top3 = round.slice(0, 3);
        top3.forEach((player, index) => {
            // Find player's game today
            const game = todaysGames.find(g => 
                g.homeTeam === player.team || g.awayTeam === player.team
            );
            
            let reasoning = '';
            if (game) {
                const isHome = game.homeTeam === player.team;
                const opponent = isHome ? game.awayTeam : game.homeTeam;
                
                // Get team standings info
                let teamStanding = null;
                let oppStanding = null;
                let teamDivision = null;
                
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

                reasoning = `
                    <strong>${index + 1}. ${player.name} (${player.team}) - ${player.prob}%</strong><br>
                    <ul>
                        <li>Season Performance: ${player.stats.goals} goals, ${player.stats.points} points in ${player.stats.gamesPlayed} games</li>
                        <li>Average ice time: ${(player.stats.toi / 60).toFixed(2)} minutes</li>
                        <li>Playing ${isHome ? 'home' : 'away'} against ${opponent}</li>
                        <li>Team standing: ${teamStanding}${getOrdinalSuffix(teamStanding)} in ${teamDivision}</li>
                        <li>Opponent standing: ${oppStanding}${getOrdinalSuffix(oppStanding)} in their division</li>
                        <li>Plus/Minus: ${player.stats.plusMinus > 0 ? '+' : ''}${player.stats.plusMinus}</li>
                    </ul>
                `;
            } else {
                reasoning = `
                    <strong>${index + 1}. ${player.name} (${player.team}) - ${player.prob}%</strong><br>
                    <ul>
                        <li>No game scheduled for today</li>
                        <li>Season stats: ${player.stats.goals} goals, ${player.stats.points} points in ${player.stats.gamesPlayed} games</li>
                    </ul>
                `;
            }
            emailContent += reasoning;
        });
        
        emailContent += '</div>\n';
        
        // Add the full round table
        emailContent += '<h4>All Players in Round</h4>\n';
        emailContent += '<table border="1" style="border-collapse: collapse; width: 100%;">\n';
        emailContent += '<tr><th>Rank</th><th>Player</th><th>Probability</th><th>Goals</th><th>+/-</th><th>Games</th><th>Points</th><th>Team</th></tr>\n';
        
        round.forEach((player, index) => {
            emailContent += `<tr>
                <td>${index + 1}</td>
                <td>${player.name}</td>
                <td>${player.prob}%</td>
                <td>${player.stats.goals}</td>
                <td>${player.stats.plusMinus}</td>
                <td>${player.stats.gamesPlayed}</td>
                <td>${player.stats.points}</td>
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
    
    try {
        const response = await fetch(`https://api-web.nhle.com/v1/standings/${today}`);
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

        return divisionStandings;
    } catch (error) {
        console.error('Error fetching standings:', error);
        return null;
    }
}

function getTodaysGames() {
    console.log('Checking for today\'s games...');
    
    const today = format(new Date(), 'yyyy-MM-dd');
    const games = new Map(); // Using Map to avoid duplicate games
    
    // Read all schedule files from the data directory
    const scheduleFiles = fs.readdirSync(DATA_DIR)
        .filter(file => file.endsWith('-schedule.json'));
    
    for (const file of scheduleFiles) {
        const scheduleData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
        
        // Look through the games array in the schedule
        for (const game of scheduleData.games) {
            const gameDate = game.gameDate.split('T')[0]; // Extract just the date part
            
            if (gameDate === today) {
                const gameKey = `${game.homeTeam.abbrev}-${game.awayTeam.abbrev}`;
                if (!games.has(gameKey)) {
                    games.set(gameKey, {
                        homeTeam: game.homeTeam.abbrev,
                        awayTeam: game.awayTeam.abbrev,
                        startTime: new Date(game.gameDate).toLocaleTimeString(),
                        venue: game.venue.default
                    });
                }
            }
        }
    }
    
    const todaysGames = Array.from(games.values());
    
    if (todaysGames.length === 0) {
        console.log('No games scheduled for today.');
    } else {
        console.log(`\nGames scheduled for ${today}:`);
        console.log('------------------------');
        todaysGames.forEach(game => {
            console.log(`${game.awayTeam} @ ${game.homeTeam} - ${game.startTime}`);
            console.log(`Venue: ${game.venue}`);
            console.log('------------------------');
        });
    }
    
    return todaysGames;
}

async function main() {
    console.log('Initializing NHL player stats analyzer...');
    const allPlayerStats = await fetchAllPlayerStats();

    if (!allPlayerStats) {
        console.log('Failed to fetch player stats. Exiting...');
        return;
    }

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

    pickRounds.forEach((picks, roundIndex) => {
        const playerAnalysis = [];

        picks.forEach(player => {
            playerAnalysis.push(analyzePlayer(player, todaysGames, standings));
        });

        playerAnalysis.sort((a, b) => b.prob - a.prob);

        console.log(`Round ${roundIndex+1}:`);
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

    // Send email report with additional data
    await sendEmailReport(analysisResults, finalChoice, todaysGames, standings);
}

main();
