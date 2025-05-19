import { RpgEvent, EventData, RpgPlayer, Components, Move } from "@rpgjs/server";

@EventData({
  name: "EV-2",
  hitbox: {
    width: 32,
    height: 16,
  },
})
export default class Villager2Event extends RpgEvent {
  onInit() {
    this.setGraphic("custom2");
    this.setComponentsTop(Components.text("Player 2"));
    this.speed = 1
    this.infiniteMoveRoute(
        [Move.tileRandom()]
    )
  }
  async onAction(player: RpgPlayer) {
    await player.showText('I give you 10 gold.', {
        talkWith: this
    })
  }
}
