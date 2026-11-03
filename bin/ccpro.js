#!/usr/bin/env node
import { main } from '../src/cli.js';

// Exiting explicitly: a usage query left over after a cancel finishes on its own.
process.exit(await main(process.argv.slice(2)));
