import { appendFile, readdirSync, readFileSync, writeFileSync } from "fs";
import { IHistoryTrade, TOrder } from "../types/orderbook.types";
import moment from 'moment';


export const safeNumber = (n: number) => parseFloat((n).toFixed(6));

export type TLogType = "ORDER" | "TRADE";

interface IClosedOrders {
    uuid: string;
    timestamp: number;
    socket_id: string;
};

export const saveLog = (name: string, type: TLogType, data: IHistoryTrade | TOrder | IClosedOrders) => {
    try {
        const date = moment().format('DD-MM-YYYY');
        const path = `logs/${type}-${name}-${date}.log`;
        const _data = `${JSON.stringify(data)}\n`;
        appendFile(path, _data, (err) => {
            if (err) throw new Error(err.message);
        });
    } catch (error: any) {
        console.log(error.message);
    }
};

export const updateOrderLog = (name: string, uuid: string, type: "CANCELED" | "FILLED" | "PT-FILLED") => {
    try {
        const _path = `logs/`;
        const data = readdirSync(_path);
        const fileNamesList = data.filter(q => q.includes(name));
        for (let i = 0; i < fileNamesList.length; i++) {
            const file = fileNamesList[i];
            const fileData = readFileSync(`${_path}${file}`, { encoding: "utf8" });
            const arrayData = fileData.split(`\n`).slice(0, -1).map(q => JSON.parse(q) as TOrder);
            const existing = arrayData.find(q => q.uuid === uuid);
            if (existing) {
                existing['state'] = type;
                writeFileSync(`${_path}${file}`, `${arrayData.map(q => JSON.stringify(q)).join('\n')}\n`)
                break;
            }

        }
    } catch (error) {
        console.log({ error });
    }
};
