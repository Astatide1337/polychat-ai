import { loadDotEnv } from "./utils/dotenv.js";

loadDotEnv();

import { Command } from "commander";
import { registerChatCommand } from "./commands/chat.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerLogoutCommand } from "./commands/logout.js";
import { registerModelsCommand } from "./commands/models.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerTemporaryCommand } from "./commands/temporary.js";
import { registerVerifyCommand } from "./commands/verify.js";

const program = new Command();

program.name("polychat").description("Polychat CLI").version("0.1.0");

registerInitCommand(program);
registerDoctorCommand(program);
registerLoginCommand(program);
registerLogoutCommand(program);
registerTemporaryCommand(program);
registerStatusCommand(program);
registerServeCommand(program);
registerChatCommand(program);
registerModelsCommand(program);
registerSessionCommand(program);
registerVerifyCommand(program);

program.parse(process.argv);
