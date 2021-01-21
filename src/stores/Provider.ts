import { action, observable, ObservableMap } from 'mobx';
import RootStore from 'stores/Root';
import { ethers } from 'ethers';
import UncheckedJsonRpcSigner from 'provider/UncheckedJsonRpcSigner';
import { ActionResponse, sendAction } from './actions/actions';
import { web3Window as window } from 'provider/Web3Window';
import { backupUrls, supportedChainId, web3Modal } from 'provider/connectors';

// NEAR imports
import Web3 from 'web3';
import { NearProvider, nearWeb3Extensions } from 'near-web3-provider';
import * as nearlib from 'nearlib';

// config object to hold near network info, we should hold this somewhere else, eventually
// important note: keystore must be part of the deps object, or the code breaks!
const nearConfig = {
    nodeUrl: 'https://rpc.betanet.near.org/',
    deps: {
        keyStore: new nearlib.keyStores.BrowserLocalStorageKeyStore(),
    },
    networkId: 'betanet',
    evmAccountId: 'evm',
    walletUrl: 'https://wallet.betanet.near.org',
    explorerUrl: 'https://explorer.betanet.near.org',
};

// Function to initialise a connection to NEAR
async function initNear() {
    const near = await nearlib.connect(nearConfig);
    console.log(`[DEBUG] nearConfig object: ` + JSON.stringify(nearConfig));
    console.log(`[DEBUG] near object: ` + JSON.stringify(near));

    const walletAccount = new nearlib.WalletAccount(near, undefined); // why does this take 2 args??
    console.log(
        `[DEBUG] near walletAccount signed in? (should be false) ` +
            walletAccount.isSignedIn()
    );

    const account = await walletAccount.requestSignIn(
        'evm',
        'Balancer Exchange',
        undefined,
        undefined
    ); // i don't know why but this needs to have the last two args specified
    console.log(
        `[DEBUG] near walletAccount signed in? (should be true) ` +
            walletAccount.isSignedIn()
    );

    const accountId = walletAccount.getAccountId();
    console.log(`[DEBUG] account id ok? ` + JSON.stringify(accountId));

    let np = new NearProvider({
        nodeUrl: nearConfig.nodeUrl,
        keyStore: nearConfig.deps.keyStore,
        masterAccountId: accountId,
        networkId: nearConfig.networkId,
        evmAccountId: nearConfig.evmAccountId,
        walletUrl: nearConfig.walletUrl,
        explorerUrl: nearConfig.explorerUrl,
        isReadOnly: false,
    });
    console.log(`[DEBUG] NearProvider: ` + JSON.stringify(np));

    return np;
    //return new NearProvider(nearConfig.nodeUrl, nearConfig.deps.keyStore, accountId, nearConfig.networkId, 'evm');
}
// END

export enum ContractTypes {
    BPool = 'BPool',
    BFactory = 'BFactory',
    TestToken = 'TestToken',
    ExchangeProxy = 'ExchangeProxy',
    Multicall = 'Multicall',
    TestTokenBytes = 'TestTokenBytes',
}

export const schema = {
    BPool: require('../abi/BPool').abi,
    BFactory: require('../abi/BFactory').abi,
    TestToken: require('../abi/TestToken').abi,
    ExchangeProxy: require('../abi/ExchangeProxy').abi,
    Multicall: require('../abi/Multicall').abi,
    TestTokenBytes: require('../abi/BTokenBytes32').abi,
};

export interface ChainData {
    currentBlockNumber: number;
}

enum ERRORS {
    UntrackedChainId = 'Attempting to access data for untracked chainId',
    ContextNotFound = 'Specified context name note stored',
    BlockchainActionNoAccount = 'Attempting to do blockchain transaction with no account',
    BlockchainActionNoChainId = 'Attempting to do blockchain transaction with no chainId',
    BlockchainActionNoResponse = 'No error or response received from blockchain action',
    NoWeb3 = 'Error Loading Web3',
}

type ChainDataMap = ObservableMap<number, ChainData>;

export interface ProviderStatus {
    activeChainId: number;
    account: string;
    library: any;
    active: boolean;
    injectedLoaded: boolean;
    injectedActive: boolean;
    injectedChainId: number;
    injectedWeb3: any;
    backUpLoaded: boolean;
    backUpWeb3: any;
    activeProvider: any;
    error: Error;
}
/*const nearConfig = {
    nodeUrl: 'https://rpc.betanet.near.org/',
    deps: {
        keyStore: new nearlib.keyStores.BrowserLocalStorageKeyStore()
    },
    networkId: 'betanet',
    evmAccountId: 'evm',
    walletUrl: 'https://wallet.betanet.near.org',
    explorerUrl: 'https://explorer.betanet.near.org'
};
*/
export default class ProviderStore {
    @observable chainData: ChainData;
    @observable providerStatus: ProviderStatus;
    web3Modal: any;
    rootStore: RootStore;

    constructor(rootStore) {
        this.rootStore = rootStore;
        this.chainData = { currentBlockNumber: -1 } as ChainData;
        this.web3Modal = web3Modal;
        this.providerStatus = {} as ProviderStatus;
        this.providerStatus.active = false;
        this.providerStatus.injectedLoaded = false;
        this.providerStatus.injectedActive = false;
        this.providerStatus.backUpLoaded = false;
        this.providerStatus.activeProvider = null;

        this.handleNetworkChanged = this.handleNetworkChanged.bind(this);
        this.handleClose = this.handleClose.bind(this);
        this.handleAccountsChanged = this.handleAccountsChanged.bind(this);
    }

    getCurrentBlockNumber(): number {
        return this.chainData.currentBlockNumber;
    }

    async loadWeb3Modal(): Promise<void> {
        let provider = await this.web3Modal.connect();
        console.log(`[Provider] Web3Modal`);
        if (provider) await this.loadWeb3(provider);
    }

    @action setCurrentBlockNumber(blockNumber): void {
        this.chainData.currentBlockNumber = blockNumber;
    }

    @action fetchUserBlockchainData = async (account: string) => {
        const {
            transactionStore,
            tokenStore,
            contractMetadataStore,
            swapFormStore,
        } = this.rootStore;

        console.debug('[Provider] fetchUserBlockchainData', {
            account,
        });

        transactionStore.checkPendingTransactions(account);
        await tokenStore.fetchBalancerTokenData(
            account,
            contractMetadataStore.getTrackedTokenAddresses()
        );

        // Makes sure the Input/Output token data is up to date
        swapFormStore.loadTokens(account);
    };

    // account is optional
    getProviderOrSigner(library, account) {
        console.debug('[getProviderOrSigner', {
            library,
            account,
            signer: library.getSigner(account),
        });

        return account
            ? new UncheckedJsonRpcSigner(library.getSigner(account))
            : library;
    }

    getContract(
        type: ContractTypes,
        address: string,
        signerAccount?: string
    ): ethers.Contract {
        const library = this.providerStatus.library;

        if (signerAccount) {
            return new ethers.Contract(
                address,
                schema[type],
                this.getProviderOrSigner(
                    this.providerStatus.library,
                    signerAccount
                )
            );
        }

        return new ethers.Contract(address, schema[type], library);
    }

    @action sendTransaction = async (
        contractType: ContractTypes,
        contractAddress: string,
        action: string,
        params: any[],
        overrides?: any
    ): Promise<ActionResponse> => {
        const { transactionStore } = this.rootStore;
        const chainId = this.providerStatus.activeChainId;
        const account = this.providerStatus.account;

        overrides = overrides ? overrides : {};

        if (!account) {
            throw new Error(ERRORS.BlockchainActionNoAccount);
        }

        if (!chainId) {
            throw new Error(ERRORS.BlockchainActionNoChainId);
        }

        const contract = this.getContract(
            contractType,
            contractAddress,
            account
        );

        const response = await sendAction({
            contract,
            action,
            sender: account,
            data: params,
            overrides,
        });

        const { error, txResponse } = response;

        if (error) {
            console.warn('[Send Transaction Error', error);
        } else if (txResponse) {
            transactionStore.addTransactionRecord(account, txResponse);
        } else {
            throw new Error(ERRORS.BlockchainActionNoResponse);
        }

        return response;
    };

    @action async handleNetworkChanged(
        networkId: string | number
    ): Promise<void> {
        console.log(
            `[Provider] Network change: ${networkId} ${this.providerStatus.active}`
        );
        // network change could mean switching from injected to backup or vice-versa
        if (this.providerStatus.active) {
            await this.loadWeb3();
            const { blockchainFetchStore } = this.rootStore;
            blockchainFetchStore.blockchainFetch(true);
        }
    }

    @action async handleClose(): Promise<void> {
        console.log(`[Provider] HandleClose() ${this.providerStatus.active}`);
        if (this.providerStatus.active) await this.loadWeb3();
    }

    @action handleAccountsChanged(accounts: string[]): void {
        console.log(`[Provider] Accounts changed`);
        if (accounts.length === 0) {
            this.handleClose();
        } else {
            const { blockchainFetchStore } = this.rootStore;
            this.providerStatus.account = accounts[0];
            // Loads pool & balance data for account
            blockchainFetchStore.blockchainFetch(true);
        }
    }

    @action async loadProvider(provider) {
        console.log(
            `[DEBUG] Attempted loadProvider call with param: ` +
                JSON.stringify(provider)
        );
        try {
            // remove any old listeners
            if (
                this.providerStatus.activeProvider &&
                this.providerStatus.activeProvider.on
            ) {
                console.log(`[Provider] Removing Old Listeners`);
                this.providerStatus.activeProvider.removeListener(
                    'chainChanged',
                    this.handleNetworkChanged
                );
                this.providerStatus.activeProvider.removeListener(
                    'accountsChanged',
                    this.handleAccountsChanged
                );
                this.providerStatus.activeProvider.removeListener(
                    'close',
                    this.handleClose
                );
                this.providerStatus.activeProvider.removeListener(
                    'networkChanged',
                    this.handleNetworkChanged
                );
            }

            if (
                this.providerStatus.library &&
                this.providerStatus.library.close
            ) {
                console.log(`[Provider] Closing Old Library.`);
                await this.providerStatus.library.close();
            }

            let web3 = new ethers.providers.Web3Provider(provider);

            if ((provider as any).isMetaMask) {
                console.log(`[Provider] MetaMask Auto Refresh Off`);
                (provider as any).autoRefreshOnNetworkChange = false;
            }

            if (provider.on) {
                console.log(`[Provider] Subscribing Listeners`);
                provider.on('chainChanged', this.handleNetworkChanged); // For now assume network/chain ids are same thing as only rare case when they don't match
                provider.on('accountsChanged', this.handleAccountsChanged);
                provider.on('close', this.handleClose);
                provider.on('networkChanged', this.handleNetworkChanged);
            }

            let network = await web3.getNetwork();

            const accounts = await web3.listAccounts();
            let account = null;
            if (accounts.length > 0) account = accounts[0];

            this.providerStatus.injectedLoaded = true;
            this.providerStatus.injectedChainId = network.chainId;
            this.providerStatus.account = account;
            this.providerStatus.injectedWeb3 = web3;
            this.providerStatus.activeProvider = provider;
            console.log(`[Provider] Injected provider loaded.`);
        } catch (err) {
            console.error(`[Provider] Injected Error`, err);
            this.providerStatus.injectedLoaded = false;
            this.providerStatus.injectedChainId = null;
            this.providerStatus.account = null;
            this.providerStatus.library = null;
            this.providerStatus.active = false;
            this.providerStatus.activeProvider = null;
        }
    }

    // There's some NEAR Code here!
    // I commented out  a bunch of code that loaded a backup provider and made it load using the near provider
    // That I've declared above
    @action async loadWeb3(provider = null) {
        console.log(
            `[DEBUG] Attempted loadWeb3 call with param: ` +
                JSON.stringify(provider)
        );
        //console.log("window.ethereum: " + JSON.stringify(window.ethereum));
        //console.log("this.providerStatus.injectedLoaded:" + this.providerStatus.injectedLoaded);
        //console.log("this.providerStatus.injectedChainId" + this.providerStatus.injectedChainId);
        //console.log(`Just the entire providerStatus: `, this.providerStatus);
        /*
        /*
        Handles loading web3 provider.
        Injected web3 loaded and active if chain Id matches.
        Backup web3 loaded and active if no injected or injected chain Id not correct.
        */
        if (provider === null && window.ethereum) {
            console.log(`[Provider] Loading Injected Provider`);
            await this.loadProvider(window.ethereum);
        } else if (provider) {
            console.log(`[Provider] Loading Provider`);
            await this.loadProvider(provider);
        }

        // If no injected provider or inject provider is wrong chain fall back to Infura
        if (
            !this.providerStatus.injectedLoaded ||
            this.providerStatus.injectedChainId !== supportedChainId
        ) {
            console.log(
                `[Provider] Reverting To Backup Provider.`,
                this.providerStatus
            );
            try {
                // The provider status object isn't properly set, I haven't looked into what it needs
                // to know, how it needs it passed and where it uses it.
                console.log('Trying to create near web3 provider!');
                /*window.nearConfig = {
                    networkId: 'betanet',
                    nodeUrl: 'https://rpc.betanet.near.org/',
                    contractName: 'balancer-core',
                    walletUrl: 'https://wallet.betanet.near.org',
                    helperUrl: 'https://helper.betanet.near.org'
                };*/
                const NearProvider = await initNear();
                /*
                let web3 = new ethers.providers.JsonRpcProvider(
                    backupUrls[supportedChainId]
                );
                */
                const web3 = new Web3(NearProvider);
                //let network = await web3.getNetwork(); This line was here and the near provider didn't seem to provide it, check what it does
                // and try figure out if we can delete it
                this.providerStatus.injectedActive = false;
                this.providerStatus.backUpLoaded = true;
                this.providerStatus.account = 'memoriesadrift.betanet'; // FIXME: this should probably take the account from initNear()
                // I'm not sure, though; worth investigating
                // We should save that account id in initNear and pass it here probably
                this.providerStatus.activeChainId = supportedChainId; // I changed this line, previously it took the network var defined above and called network.chainId
                this.providerStatus.backUpWeb3 = web3;
                this.providerStatus.library = web3;
                this.providerStatus.activeProvider = 'backup'; //backupUrls[supportedChainId];
                console.log(`[Provider] BackUp Provider Loaded & Active`);
            } catch (err) {
                console.error(`[Provider] loadWeb3 BackUp Error`, err);
                this.providerStatus.injectedActive = false;
                this.providerStatus.backUpLoaded = false;
                this.providerStatus.account = null;
                this.providerStatus.activeChainId = null;
                this.providerStatus.backUpWeb3 = null;
                this.providerStatus.library = null;
                this.providerStatus.active = false;
                this.providerStatus.error = new Error(ERRORS.NoWeb3);
                this.providerStatus.activeProvider = null;
                return;
            }
        } else {
            console.log(`[Provider] Injected provider active.`);
            this.providerStatus.library = this.providerStatus.injectedWeb3;
            this.providerStatus.activeChainId = this.providerStatus.injectedChainId;
            // Only fetch if not first page load as could be change of provider
            if (
                this.providerStatus.account &&
                this.providerStatus.injectedActive
            )
                this.fetchUserBlockchainData(this.providerStatus.account);

            this.providerStatus.injectedActive = true;
        }

        this.providerStatus.active = true;
        console.log(`[Provider] Provider Active.`, this.providerStatus);
    }
}
