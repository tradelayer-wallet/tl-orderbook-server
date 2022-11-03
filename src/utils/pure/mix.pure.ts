import { appendFileSync, readFileSync, writeFileSync } from "fs";
export enum ELogType {
    TXIDS = 'TXIDS',
    ORDERS = 'ORDERS',
    CLOSED_ORDERS = 'CLOSED_ORDERS',
    MATCHES = 'MATCHES',
}

export const safeNumber = (n: number) => parseFloat((n).toFixed(6));

export const logsPath = `logs`;
export const saveLog = (logType: ELogType, data: string) => {
    try {
        const maxLines = 100;
        const fileName = `${logType}`;
        const line = `${data}\n`;
        const path = `${logsPath}/${fileName}.log`;
        appendFileSync(path, line);

        try {
            const readyRes = readFileSync(path, { encoding: 'utf8' });
            const logArray = readyRes
                .split('\n')
                .slice(0, -1);
            if (logArray.length > maxLines) {
                const newData = `${logArray.slice(-1 * maxLines).join('\n')}\n`;
                writeFileSync(path, newData);
            }
        } catch(readError) {
            console.log(readError)
        }
    } catch (error) {
        console.log(error);
    }
};