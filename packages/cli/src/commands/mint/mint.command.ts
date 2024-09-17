import { Command, Option } from 'nest-commander';
import {
  getUtxos,
  OpenMinterTokenInfo,
  getTokenMinter,
  logerror,
  getTokenMinterCount,
  isOpenMinter,
  sleep,
  needRetry,
  unScaleByDecimals,
  getTokens,
  btc,
  TokenMetadata,
  MinterType,
} from 'src/common';
import { getRemainSupply, openMint } from './ft.open-minter';
import { ConfigService, SpendService, WalletService } from 'src/providers';
import { Inject } from '@nestjs/common';
import { log } from 'console';
import { findTokenMetadataById, scaleConfig } from 'src/token';
import Decimal from 'decimal.js';
import {
  BoardcastCommand,
  BoardcastCommandOptions,
} from '../boardcast.command';
import { broadcastMergeTokenTxs, mergeTokens } from '../send/merge';
import { calcTotalAmount, sendToken } from '../send/ft';
import { pickLargeFeeUtxo } from '../send/pick';
interface MintCommandOptions extends BoardcastCommandOptions {
  id: string;
  new?: number;
}

function getRandomInt(max: number) {
  return Math.floor(Math.random() * max);
}

@Command({
  name: 'mint',
  description: 'Mint a token',
})
export class MintCommand extends BoardcastCommand {
  constructor(
    @Inject() private readonly spendService: SpendService,
    @Inject() protected readonly walletService: WalletService,
    @Inject() protected readonly configService: ConfigService,
  ) {
    super(spendService, walletService, configService);
  }

  async cat_cli_run(
    passedParams: string[],
    options?: MintCommandOptions,
  ): Promise<void> {
    try {
      if (options.id) {
        const address = this.walletService.getAddress();
        const token = await findTokenMetadataById(
          this.configService,
          options.id,
        );

        if (!token) {
          console.error(`No token found for tokenId: ${options.id}`);
          return;
        }

        const scaledInfo = scaleConfig(token.info as OpenMinterTokenInfo);

        let amount: bigint | undefined;

        if (passedParams[0]) {
          try {
            const d = new Decimal(passedParams[0]).mul(
              Math.pow(10, scaledInfo.decimals),
            );
            amount = BigInt(d.toString());
          } catch (error) {
            logerror(`Invalid amount: "${passedParams[0]}"`, error);
            return;
          }
        }

        const MAX_RETRY_COUNT = 10000000;

        for (let index = 0; index < MAX_RETRY_COUNT; index++) {
          //await this.merge(token, address);
          let feeRate =  this.configService.getFeeRate();
          const response = await fetch('https://mempool.fractalbitcoin.io/api/v1/fees/recommended');
          if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
          if(feeRate<=0) feeRate = Math.floor((await response.json()).fastestFee*1.01);
          console.log('fastestFee',feeRate)

          let feeUtxos = await this.getFeeUTXOs(address);

          if (feeUtxos.length === 0) {
            console.warn('Insufficient satoshis balance!');
            return;
          }

          const count = await getTokenMinterCount(
            this.configService,
            token.tokenId,
          );

          //const maxTry = count < MAX_RETRY_COUNT ? count : MAX_RETRY_COUNT;

          //if (count == 0 && index >= maxTry) {
          //  console.error('No available minter UTXO found!');
          //  return;
          //}

          const offset = getRandomInt(count - feeUtxos.length*2);
          let minters = await getTokenMinter(
            this.configService,
            this.walletService,
            token,
            offset,
            feeUtxos.length*2
          );
          
          const double = async(feeUtxo,minter) =>{

          if (minter == null) {
            return
          }

          if (isOpenMinter(token.info.minterMd5)) {
            const minterState = minter.state.data;
            if (minterState.isPremined && amount > scaledInfo.limit) {
              console.error('The number of minted tokens exceeds the limit!');
              return;
            }

            const limit = scaledInfo.limit;

            if (!minter.state.data.isPremined && scaledInfo.premine > 0n) {
              if (typeof amount === 'bigint') {
                if (amount !== scaledInfo.premine) {
                  throw new Error(
                    `first mint amount should equal to premine ${scaledInfo.premine}`,
                  );
                }
              } else {
                amount = scaledInfo.premine;
              }
            } else {
              amount = amount || limit;
              if (token.info.minterMd5 === MinterType.OPEN_MINTER_V1) {
                if (
                  getRemainSupply(minter.state.data, token.info.minterMd5) <
                  limit
                ) {
                  console.warn(
                    `small limit of ${unScaleByDecimals(limit, token.info.decimals)} in the minter UTXO!`,
                  );
                  log(`retry to mint token [${token.info.symbol}] ...`);
                  return
                }
                amount =
                  amount >
                  getRemainSupply(minter.state.data, token.info.minterMd5)
                    ? getRemainSupply(minter.state.data, token.info.minterMd5)
                    : amount;
              } else if (
                token.info.minterMd5 == MinterType.OPEN_MINTER_V2 &&
                amount != limit
              ) {
                console.warn(
                  `can only mint at the exactly amount of ${limit} at once`,
                );
                amount = limit;
              }
            }

            const mintTxIdOrErr = await openMint(
              this.configService,
              this.walletService,
              this.spendService,
              feeRate,
              [feeUtxo],
              token,
              0,
              minter,
              amount,
            );

            if (mintTxIdOrErr instanceof Error) return

            console.log(
              `Minting ${unScaleByDecimals(amount, token.info.decimals)} ${token.info.symbol} tokens in txid: ${mintTxIdOrErr} ...`,
            );
            return;
          } else {
            throw new Error('unkown minter!');
          }
        }
        console.log('过滤前 ','miner', minters.length, 'feeUtxos', feeUtxos.length);

         // Define variables for UTXO filtering
         const SATOSHIS_PER_BTC = 100000000; // Number of satoshis in 1 BTC
         const MAX_UTXO_SIZE = SATOSHIS_PER_BTC; // 1 BTC
         const MIN_UTXO_SIZE = 0//0.01*SATOSHIS_PER_BTC; // Minimum UTXO size

         // Filter and sort UTXOs
         feeUtxos = [...feeUtxos]
         .filter(utxo => utxo.satoshis <= MAX_UTXO_SIZE) // Use UTXOs smaller than 1 FB
         .filter(utxo => utxo.satoshis >= MIN_UTXO_SIZE) // Use UTXOs larger than the minimum size
         .sort((a, b) => b.satoshis - a.satoshis); // Sort from largest to smallest

         const totalSatoshis = feeUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0);

         console.log('过滤后 ','miner', minters.length, 'feeUtxos', feeUtxos.length,totalSatoshis/SATOSHIS_PER_BTC);

        const mintingPromises = [];

        for (let i = 0; i < feeUtxos.length; i++) { 
          if (i >= minters.length) break;
          const feeUtxo = feeUtxos[i];
          const minter=minters[i]
          mintingPromises.push(double(feeUtxo,minter));
        }
        await Promise.all(mintingPromises);
      }
        console.error(`mint token [${token.info.symbol}] failed`);
      } else {
        throw new Error('expect a ID option');
      }
    } catch (error) {
      logerror('mint failed!', error);
    }
  }

  async merge(metadata: TokenMetadata, address: btc.Addres) {
    const res = await getTokens(
      this.configService,
      this.spendService,
      metadata,
      address,
    );

    if (res !== null) {
      const { contracts: tokenContracts } = res;

      if (tokenContracts.length > 1) {
        const cachedTxs: Map<string, btc.Transaction> = new Map();
        console.info(`Start merging your [${metadata.info.symbol}] tokens ...`);

        const feeUtxos = await this.getFeeUTXOs(address);
        const feeRate = await this.getFeeRate();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [newTokens, newFeeUtxos, e] = await mergeTokens(
          this.configService,
          this.walletService,
          this.spendService,
          feeUtxos,
          feeRate,
          metadata,
          tokenContracts,
          address,
          cachedTxs,
        );

        if (e instanceof Error) {
          logerror('merge token failed!', e);
          return;
        }

        const feeUtxo = pickLargeFeeUtxo(newFeeUtxos);

        if (newTokens.length > 1) {
          const amountTobeMerge = calcTotalAmount(newTokens);
          const result = await sendToken(
            this.configService,
            this.walletService,
            feeUtxo,
            feeRate,
            metadata,
            newTokens,
            address,
            address,
            amountTobeMerge,
            cachedTxs,
          );
          if (result) {
            await broadcastMergeTokenTxs(
              this.configService,
              this.walletService,
              this.spendService,
              [result.commitTx, result.revealTx],
            );

            console.info(
              `Merging your [${metadata.info.symbol}] tokens in txid: ${result.revealTx.id} ...`,
            );
          }
        }
      }
    }
  }

  @Option({
    flags: '-i, --id [tokenId]',
    description: 'ID of the token',
  })
  parseId(val: string): string {
    return val;
  }

  async getFeeUTXOs(address: btc.Address) {
    let feeUtxos = await getUtxos(
      this.configService,
      this.walletService,
      address,
    );

    // feeUtxos = feeUtxos.filter((utxo) => {
    //   return this.spendService.isUnspent(utxo);
    // });

    if (feeUtxos.length === 0) {
      console.warn('Insufficient satoshis balance!');
      return [];
    }
    return feeUtxos;
  }
}
