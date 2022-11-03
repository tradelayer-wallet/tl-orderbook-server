import * as dotenv from 'dotenv';
import { join } from 'path';

const envFile = process.env.NODE_ENV === 'production' ? 'production.env' : 'development.env';
const path = join('environments', envFile);
dotenv.config({ path });

export const envConfig: {
    SERVER_PORT: number;
} = {
    SERVER_PORT: parseInt(process.env.SERVER_PORT),
};
