import { BinanceDataKline, CandleStickData } from '../Models/BinanceKlines';
import { OrderBook } from '../Models/BinanceDepth';
import { TradingPair } from '../Models/BinanceTicket';
import { Dispatch, SetStateAction } from 'react';
import {BinanceAPI} from "../http";
import {SolidityModel} from "../Models/SolidityModels.ts";

export default class SolidityScreenerService {
	static FetchAllSymbols = async (minVolume: number): Promise<string[]> => {
		const { data } = await BinanceAPI.get<TradingPair[]>(
			'/ticker/24hr'
		);

		return data
			.filter(tradingPair => {
				return tradingPair.symbol.substring(tradingPair.symbol.length - 4, tradingPair.symbol.length) === "USDT"
			})
			.filter(tradingPair => tradingPair.quoteVolume > minVolume)
			.map(tradingPair => tradingPair.symbol);
	};

	static GetTicket = async (symbol: string): Promise<TradingPair> => {
		const { data: ticker } = await BinanceAPI.get<TradingPair>(
			`/ticker/24hr?symbol=${symbol}`
		)
		return ticker;
	}

	static StreamKlines = async (
		symbol: string,
		interval: string,
		limit: number,
		setKlines: Dispatch<SetStateAction<CandleStickData[]>>,
		setKlinesStreamSocket: Dispatch<SetStateAction<WebSocket | null>>
	): Promise<void> => {
		try {
			const { data } = await BinanceAPI.get<BinanceDataKline[]>(
				`/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
			);
			await setKlines(
				data.map(candlestick => ({
					date: new Date(candlestick[0]),
					open: Number(candlestick[1]),
					high: Number(candlestick[2]),
					low: Number(candlestick[3]),
					close: Number(candlestick[4]),
					volume: Number(candlestick[5]),
				}))
			);

			const newKlinesStreamSocket: WebSocket = new WebSocket(
				`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`
			);

			newKlinesStreamSocket.onmessage = event => {
				console.log(`stream from ${symbol}`);
				const klineData = JSON.parse(event.data);

				if (klineData.e === 'kline') {
					const candlestick = klineData.k;

					const newKline: CandleStickData = {
						date: new Date(klineData.k.t),
						open: Number(candlestick.o),
						high: Number(candlestick.h),
						low: Number(candlestick.l),
						close: Number(candlestick.c),
						volume: Number(candlestick.v),
					};

					setKlines(prevData => {
						const lastKline = prevData[prevData.length - 1];
						if (lastKline.date.getTime() === newKline.date.getTime()) {
							return [...prevData.slice(0, -1), newKline];
						} else {
							return [...prevData, newKline];
						}
					});
				}
			};

			await setKlinesStreamSocket(newKlinesStreamSocket);
		} catch (e) {
			console.log(e);
		}
	};

	static FetchOrderBook = async (symbol: string): Promise<OrderBook> => {
		const { data } = await BinanceAPI.get<OrderBook>(
			`/depth?symbol=${symbol}`
		);
		return data;
	};

	static FindSolidity = async (
		symbol: string,
		ratioAccess: number
	): Promise<SolidityModel> => {
		const orderBook = await this.FetchOrderBook(symbol);
		const { quoteVolume } = await this.GetTicket(symbol);

		let sumAsks = 0;
		let maxAsk = 0;
		let maxAskPrice = 0;
		orderBook.asks.forEach(ask => {
			const volume = parseFloat(ask[1]);
			sumAsks += volume;
			if (maxAsk < volume) {
				maxAsk = volume;
				maxAskPrice = parseFloat(ask[0]);
			}
		});

		let sumBids = 0;
		let maxBid = 0;
		let maxBidPrice = 0;
		orderBook.bids.forEach(bid => {
			const volume = parseFloat(bid[1]);
			sumBids += volume;
			if (maxBid < volume) {
				maxBid = volume;
				maxBidPrice = parseFloat(bid[0]);
			}
		});

		const solidityOnAsks = maxAsk / (sumAsks / 100) > ratioAccess;
		const solidityOnBids = maxBid / (sumBids / 100) > ratioAccess;

		const solidityModel: SolidityModel = {
			symbol: symbol,
			quoteVolume: quoteVolume,
			buyVolume: sumAsks,
			sellVolume: sumBids,
		}

		if (solidityOnAsks || solidityOnBids) {
			if (solidityOnAsks) {
				solidityModel.solidityLong = {
					price: maxAskPrice,
					volume: maxAsk,
				};
			}
			if (solidityOnBids) {
				solidityModel.solidityShort = {
					price: maxBidPrice,
					volume: maxBid,
				};
			}
		}

		return solidityModel;
	};

	static FindAllSolidity = async (minVolume: number, ratioAccess: number) => {
		const symbols = await this.FetchAllSymbols(minVolume);
		const symbolsWithSolidity: string[] = [];

		const startTime = new Date();

		const symbolsGroupLength = 30;

		for (let i = 0; i < symbols.length; i += symbolsGroupLength) {
			const symbolsGroup =
				symbols.length - i > symbolsGroupLength ? symbols.slice(i, i + symbolsGroupLength) : symbols.slice(i, symbols.length);

			await Promise.all(
				symbolsGroup.map(async (symbol) => {
					const solidityInfo = await this.FindSolidity(symbol, ratioAccess);
					if (solidityInfo !== null) {
						symbolsWithSolidity.push(symbol);
					}
				})
			);
		}

		const endTime = new Date();

		console.log(new Date(endTime.getTime() - startTime.getTime()).getSeconds())
		return symbolsWithSolidity;
	};
}
