import { Bot } from "mineflayer";
import AshPvP from "./pvp";

declare module "mineflayer" {
  interface Bot {
    ashpvp: AshPvP;
  }

  interface BotEvent {
    hit: () => void;
  }
}
