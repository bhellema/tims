#!/usr/bin/env node

import fetch from 'node-fetch';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { format } from 'date-fns';

const API_URL = 'https://api.nhle.com/stats/rest/en/skater/summary';
const HOME_DIR = path.join(os.homedir(), '.tims');
const DATA_DIR = path.join(HOME_DIR, 'data');
const PICKS_BASE_DIR = path.join(HOME_DIR, 'picks');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(PICKS_BASE_DIR)) {
    fs.mkdirSync(PICKS_BASE_DIR, { recursive: true });
}

function getTodayFilename() {
    return path.join(DATA_DIR, `${format(new Date(), 'yyyy-MM-dd')}.json`);
}

function getLatestDataFile() {
    const files = fs.readdirSync(DATA_DIR).filter(file => file.endsWith('.json'));
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

async function fetchAllPlayerStats() {
    const todayFile = getTodayFilename();
    const latestFile = getLatestDataFile();

    if (latestFile && latestFile === todayFile && fs.existsSync(todayFile)) {
        console.log('Using cached player data from today...');
        return JSON.parse(fs.readFileSync(todayFile, 'utf8'));
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

    console.log(`Completed fetching all players. Total players: ${allPlayers.length}`);
    fs.writeFileSync(todayFile, JSON.stringify(allPlayers, null, 2), 'utf8');
    return allPlayers;
}

function setupReadline(playerNames) {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: (line) => {
            const hits = playerNames.filter(name => name.toLowerCase().startsWith(line.toLowerCase()));
            return [hits.length ? hits : playerNames, line];
        }
    });
}

async function getPlayerNames(playerNamesList) {
    const rl = setupReadline(playerNamesList);
    const playerNames = [];
    
    const askForPlayer = () => {
        return new Promise((resolve) => {
            rl.question('Enter player name (or type "done" when finished): ', (answer) => {
                resolve(answer.trim());
            });
        });
    };

    while (true) {
        const playerName = await askForPlayer();
        if (playerName.toLowerCase() === 'done') {
            break;
        }
        playerNames.push(playerName);
    }

    rl.close();
    return playerNames;
}

function analyzePlayer(playerStats) {
    return {
        name: playerStats.skaterFullName,
        score: playerStats.goals,
        stats: {
            goals: playerStats.goals,
            plusMinus: playerStats.plusMinus,
            gamesPlayed: playerStats.gamesPlayed,
            points: playerStats.points,
            team: playerStats.teamAbbrevs
        }
    };
}

async function main() {
    console.log('Initializing NHL player stats analyzer...');
    const allPlayerStats = await fetchAllPlayerStats();
    
    if (!allPlayerStats) {
        console.log('Failed to fetch player stats. Exiting...');
        return;
    }

    const allPlayerNames = allPlayerStats.map(player => player.skaterFullName);
    console.log('\nPlease enter the names of players you want to analyze (autocomplete enabled):');
    const playerNames = await getPlayerNames(allPlayerNames);

    const picksFilename = getNextPicksFilename();
    fs.writeFileSync(picksFilename, JSON.stringify(playerNames, null, 2), 'utf8');
    console.log(`Player picks saved to ${picksFilename}`);

    const playerAnalysis = [];
    
    for (const name of playerNames) {
        const playerStats = allPlayerStats.find(p => 
            p.skaterFullName.toLowerCase().includes(name.toLowerCase())
        );

        if (playerStats) {
            playerAnalysis.push(analyzePlayer(playerStats));
        } else {
            console.log(`Player "${name}" not found in the database.`);
        }
    }

    playerAnalysis.sort((a, b) => b.score - a.score);

    console.log('\nPlayer Analysis Results:');
    console.log('------------------------');
    playerAnalysis.forEach((player, index) => {
        console.log(`${index + 1}. ${player.name}`);
        console.log(`   Score: ${player.score}`);
        console.log(`   Goals: ${player.stats.goals}`);
        console.log(`   Plus/Minus: ${player.stats.plusMinus}`);
        console.log(`   Points: ${player.stats.points}`);
        console.log(`   Games Played: ${player.stats.gamesPlayed}`);
        console.log(`   Team: ${player.stats.team}`);
        console.log('------------------------');
    });
}

main();
