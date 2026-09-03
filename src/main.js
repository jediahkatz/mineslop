import "./style.css";
import "./settlement.css";
import { VoxelGame } from "./game.js";

const game = new VoxelGame(document.querySelector("#game"));
game.start().catch((error) => game.showError(error));
