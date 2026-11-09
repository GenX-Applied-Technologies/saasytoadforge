# Game prototype provenance and distribution notices

- **Procedural player, seed, wall textures:** original geometric drawing commands
  in `src/main.js`, created for this Forge proof, no external art/images or model
  weights used. These generated visual assets are dedicated under **CC0 1.0**:
  https://creativecommons.org/publicdomain/zero/1.0/ . We use self-generated shapes
  rather than depending on external asset downloads. No Kenney/SpriteCook files
  are included, and no unverifiable external provenance is claimed.
- **Phaser 3.90.0:** MIT, https://github.com/phaserjs/phaser/tree/v3.90.0 .
  Source license: `node_modules/phaser/LICENSE.md`. The build retains bundled
  license comments in `dist/game.js.LEGAL.txt` and copies the full MIT text to
  `dist/PHASER-LICENSE.txt`; distribute both with game.js.
- **esbuild 0.25.12:** MIT build tooling, https://github.com/evanw/esbuild .
- **Playwright:** existing Forge Apache-2.0 dev/test dependency,
  https://github.com/microsoft/playwright . Not bundled into the game.

CC0 art does not relicense the Phaser engine or other third-party code. Preserve
third-party MIT/Apache notices when distributing them. Game glue is subject to
the Forge repository's existing code-license terms; this file does not assert a
new license for the whole repository. No music, voice, trademarks, fetched art,
paid media or generative-model assets are shipped. Commercial use still needs
normal rights review for any future assets you add.
