import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { parseMoney } from "@x402/core/utils";
import { isDenom, isPositiveIntegerString } from "../../utils";

/**
 * Cosmos SDK server implementation for the exact payment scheme.
 *
 * Prices are bank denoms in base units. There is no default USD asset: a
 * money string (`"$0.01"`) needs a registered money parser that names the
 * denom, such as an `ibc/…` USDC on the chain.
 */
export class ExactCosmosScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization", "upfront"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   *
   * @param parser - Custom money parser
   * @returns This server scheme
   */
  registerMoneyParser(parser: MoneyParser): ExactCosmosScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parses a price into a bank denom amount.
   *
   * @param price - `{ amount, asset }` in base units, or a money string for a registered parser
   * @param network - Network identifier
   * @returns Parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      return validate({ amount: price.amount, asset: price.asset, extra: price.extra || {} });
    }
    const { amount } = parseMoney(price);
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return validate(result);
      }
    }
    throw new Error(
      `No default asset on ${network}: price it as { amount, asset } with a bank denom, or register a money parser`,
    );
  }

  /**
   * Returns the requirements unchanged: the payer pays the fee, so nothing is added.
   *
   * @param paymentRequirements - Base payment requirements
   * @param _supportedKind - Facilitator-supported kind
   * @param _extensionKeys - Supported facilitator extension keys
   * @returns The same requirements
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    return Promise.resolve(paymentRequirements);
  }
}

/**
 * Checks a parsed amount is an integer of a bank denom.
 *
 * @param assetAmount - Parsed amount
 * @returns The same amount
 */
function validate(assetAmount: AssetAmount): AssetAmount {
  if (!assetAmount.asset || !isDenom(assetAmount.asset)) {
    throw new Error(`Cosmos prices need a bank denom as asset, got "${assetAmount.asset}"`);
  }
  if (!isPositiveIntegerString(assetAmount.amount)) {
    throw new Error(
      `Cosmos prices need a positive integer amount in base units, got "${assetAmount.amount}"`,
    );
  }
  return assetAmount;
}
