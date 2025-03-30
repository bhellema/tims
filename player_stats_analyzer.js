#!/usr/bin/env node

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { format } from 'date-fns';
import puppeteer from 'puppeteer';

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

async function scrapeInjuredPlayers() {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );

    await page.goto('https://puckpedia.com/injuries', {
        waitUntil: 'networkidle2',
        timeout: 10000
    });

    const injuredPlayers = await page.evaluate(() => {
        const players = [];
        const table = document.querySelector('.pp_table');
        table.querySelectorAll('.pp_link').forEach(element => {
            // Schuldt, Jimmy
            let name = element.innerText;
            const [last, first] = name.split(',');
            players.push(first.trim() + ' ' + last.trim());
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

    const rounds = await page.evaluate(() => {
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

    const filteredPlayerData = rounds.map(round => {
        return round.filter(player => {
            const pp = allPlayerStats.find((ps) => ps.playerId == player.id);
            if (injuredPlayers.includes(pp.skaterFullName)) {
                console.warn(`🚨 ${pp.skaterFullName} is injured!`);
                return false;
            } 
            return true;
        });
    });

    return filteredPlayerData;
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

function analyzePlayer(playerStats) {
    const prob = calculateScoringProbability(playerStats);
    return {
        name: playerStats.skaterFullName,
        score: prob,
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

async function main() {
    console.log('Initializing NHL player stats analyzer...');
    const allPlayerStats = await fetchAllPlayerStats();

    if (!allPlayerStats) {
        console.log('Failed to fetch player stats. Exiting...');
        return;
    }

    const injuredPlayers = await scrapeInjuredPlayers();
    const pickRounds = await scrapePlayerNames(injuredPlayers, allPlayerStats);

    const finalChoice = [];

    pickRounds.forEach((pick, index) => {
        const playerAnalysis = [];

        pick.forEach(player => {
            const playerStats = allPlayerStats.find(p =>
              p.playerId == player.id
            );

            if (playerStats) {
                playerAnalysis.push(analyzePlayer(playerStats));
            } else {
                console.log(`Player "${name}" not found in the database.`);
            }
        });

        playerAnalysis.sort((a, b) => b.score - a.score);

        // console.log('\nPlayer Analysis Results:');
        // console.log('------------------------');
        // playerAnalysis.forEach((player, index) => {
        //     console.log(`${index + 1}. ${player.name}`);
        //     console.log(`   Score: ${player.score}`);
        //     console.log(`   Goals: ${player.stats.goals}`);
        //     console.log(`   Plus/Minus: ${player.stats.plusMinus}`);
        //     console.log(`   Points: ${player.stats.points}`);
        //     console.log(`   Games Played: ${player.stats.gamesPlayed}`);
        //     console.log(`   Team: ${player.stats.team}`);
        //     console.log('------------------------');
        // });

        if (playerAnalysis.length > 0) {
            finalChoice.push(playerAnalysis[0].name);
        }
    });

    finalChoice.forEach((choice) => {
        console.log(`Recommended player for pick: ${choice}\n`);
    });
}

main();
