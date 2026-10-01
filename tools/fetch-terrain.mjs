#!/usr/bin/env node
// Bake ACT's 2024 bare-earth LiDAR through rasterio's HTTP range reader.
// Install tools/terrain-requirements.txt in a virtual environment, then set
// TERRAIN_PYTHON to that environment's Python executable.
import {spawnSync} from 'node:child_process';
const result = spawnSync(process.env.TERRAIN_PYTHON || 'python3', ['-u', 'tools/bake-terrain.py'], {stdio: 'inherit'});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
