import Phaser from 'phaser'

// Original procedural geometric textures. Art is dedicated CC0; see LICENSES.md.
class Garden extends Phaser.Scene {
  constructor() { super('garden'); this.score = 0 }

  create() {
    this.score = 0
    const art = this.make.graphics({ x: 0, y: 0 })
    if (!this.textures.exists('player')) {
      art.fillStyle(0x75df98).fillRoundedRect(0, 0, 28, 28, 7)
      art.fillStyle(0x152838).fillCircle(9, 10, 3).fillCircle(19, 10, 3)
      art.generateTexture('player', 28, 28).clear()
      art.fillStyle(0x526c81).fillRect(0, 0, 32, 32)
      art.lineStyle(2, 0x8399a8).strokeRect(1, 1, 30, 30)
      art.generateTexture('wall', 32, 32).clear()
      art.fillStyle(0xffd46a).fillCircle(10, 10, 9)
      art.generateTexture('seed', 20, 20)
    }
    art.destroy()
    this.walls = this.physics.add.staticGroup()
    // Full-height obstacle starts below the first seed: test can reach it and collide.
    this.walls.create(272, 208, 'wall').setDisplaySize(32, 256).refreshBody()
    this.walls.create(440, 288, 'wall').setDisplaySize(112, 32).refreshBody()
    this.player = this.physics.add.sprite(64, 64, 'player').setCollideWorldBounds(true)
    this.physics.add.collider(this.player, this.walls)
    this.seeds = this.physics.add.staticGroup()
    for (const [x, y] of [[160, 64], [400, 64], [560, 208]]) this.seeds.create(x, y, 'seed')
    this.physics.add.overlap(this.player, this.seeds, (_player, seed) => {
      seed.disableBody(true, true)
      this.score++
      this.renderStatus()
    })
    this.keys = this.input.keyboard.addKeys('up,down,left,right,W,A,S,D,R')
    this.renderStatus()
    const restart = () => this.scene.restart()
    this.input.keyboard.on('keydown-R', restart)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.input.keyboard.off('keydown-R', restart))
    // Read-only observation seam; tests drive real keyboard input, never mutate physics.
    window.forgeGame = Object.freeze({ snapshot: () => ({
      ready: true, x: this.player.x, y: this.player.y, score: this.score,
      remaining: this.seeds.countActive(true),
    }) })
  }

  renderStatus() {
    document.querySelector('#status').textContent = `Score: ${this.score} / 3${this.score === 3 ? ' — Garden complete! Press R to restart.' : ''}`
  }

  update() {
    const x = Number(this.keys.right.isDown || this.keys.D.isDown) - Number(this.keys.left.isDown || this.keys.A.isDown)
    const y = Number(this.keys.down.isDown || this.keys.S.isDown) - Number(this.keys.up.isDown || this.keys.W.isDown)
    this.player.setVelocity(x * 180, y * 180)
    if (x && y) this.player.body.velocity.normalize().scale(180)
  }
}

new Phaser.Game({
  type: Phaser.CANVAS, width: 640, height: 384, parent: 'game', backgroundColor: '#203b3b',
  physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: Garden,
})
