// Copyright (c) .NET Foundation. All rights reserved.
// Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.

import { DefaultHttpClient } from "./DefaultHttpClient";
import { HttpClient } from "./HttpClient";
import { IConnection } from "./IConnection";
import { IHttpConnectionOptions } from "./IHttpConnectionOptions";
import { ILogger, LogLevel } from "./ILogger";
import { IReconnectPolicy } from "./IReconnectPolicy";
import { HttpTransportType, ITransport, TransferFormat } from "./ITransport";
import { LongPollingTransport } from "./LongPollingTransport";
import { ServerSentEventsTransport } from "./ServerSentEventsTransport";
import { Arg, createLogger, Platform } from "./Utils";
import { WebSocketTransport } from "./WebSocketTransport";

/** @private */
const enum ConnectionState {
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
}

/** @private */
export interface INegotiateResponse {
    connectionId?: string;
    availableTransports?: IAvailableTransport[];
    url?: string;
    accessToken?: string;
    error?: string;
}

/** @private */
export interface IAvailableTransport {
    transport: keyof typeof HttpTransportType;
    transferFormats: Array<keyof typeof TransferFormat>;
}

const MAX_REDIRECTS = 100;

let WebSocketModule: any = null;
let EventSourceModule: any = null;
if (Platform.isNode && typeof require !== "undefined") {
    // In order to ignore the dynamic require in webpack builds we need to do this magic
    // @ts-ignore: TS doesn't know about these names
    const requireFunc = typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;
    WebSocketModule = requireFunc("ws");
    EventSourceModule = requireFunc("eventsource");
}

/** @private */
export class HttpConnection implements IConnection {
    private connectionState: ConnectionState;
    private baseUrl: string;
    private readonly httpClient: HttpClient;
    private readonly logger: ILogger;
    private readonly options: IHttpConnectionOptions;
    private transport?: ITransport;
    private transferFormat?: TransferFormat;
    private startPromise?: Promise<void>;
    private stopError?: Error;
    private accessTokenFactory?: () => string | Promise<string>;

    public readonly features: any = {};
    public onreceive: ((data: string | ArrayBuffer) => void) | null;
    public onclose: ((e?: Error) => void) | null;
    public onreconnecting: ((e?: Error) => void) | null;

    // REVIEW: I would like to have a connectionId param here to highlight it will change,
    // but we don't currently expose connectionId.
    public onreconnected: (() => void) | null;

    constructor(url: string, options: IHttpConnectionOptions = {}) {
        Arg.isRequired(url, "url");

        this.logger = createLogger(options.logger);
        this.baseUrl = this.resolveUrl(url);

        options = options || {};
        options.logMessageContent = options.logMessageContent || false;

        if (!Platform.isNode && typeof WebSocket !== "undefined" && !options.WebSocket) {
            options.WebSocket = WebSocket;
        } else if (Platform.isNode && !options.WebSocket) {
            if (WebSocketModule) {
                options.WebSocket = WebSocketModule;
            }
        }

        if (!Platform.isNode && typeof EventSource !== "undefined" && !options.EventSource) {
            options.EventSource = EventSource;
        } else if (Platform.isNode && !options.EventSource) {
            if (typeof EventSourceModule !== "undefined") {
                options.EventSource = EventSourceModule;
            }
        }

        this.httpClient = options.httpClient || new DefaultHttpClient(this.logger);
        this.connectionState = ConnectionState.Disconnected;
        this.options = options;
        this.onreceive = null;
        this.onclose = null;
        this.onreconnecting = null;
        this.onreconnected = null;
    }

    public start(): Promise<void>;
    public start(transferFormat: TransferFormat): Promise<void>;
    public start(transferFormat?: TransferFormat): Promise<void> {
        transferFormat = transferFormat || TransferFormat.Binary;

        Arg.isIn(transferFormat, TransferFormat, "transferFormat");

        this.logger.log(LogLevel.Debug, `Starting connection with transfer format '${TransferFormat[transferFormat]}'.`);

        if (this.connectionState !== ConnectionState.Disconnected) {
            return Promise.reject(new Error("Cannot start a connection that is not in the 'Disconnected' state."));
        }

        this.connectionState = ConnectionState.Connecting;
        this.transferFormat = transferFormat;

        this.startPromise = this.startInternal(transferFormat);
        return this.startPromise;
    }

    public send(data: string | ArrayBuffer): Promise<void> {
        if (this.connectionState !== ConnectionState.Connected) {
            return Promise.reject(new Error("Cannot send data if the connection is not in the 'Connected' State."));
        }

        // Transport will not be null if state is connected
        return this.transport!.send(data);
    }

    public async stop(error?: Error): Promise<void> {
        this.connectionState = ConnectionState.Disconnected;
        // allowReconnect: false
        await this.stopTransport(false, error);
    }

    public async connectionLost(error: Error) {
        try {
            // allowReconnect: true
            await this.stopTransport(true, error);
        } catch (e) {
            this.connectionState = ConnectionState.Disconnected;
            throw e;
        }
    }

    private async startInternal(transferFormat: TransferFormat): Promise<void> {
        // Store the original base url and the access token factory since they may change
        // as part of negotiating
        let url = this.baseUrl;
        this.accessTokenFactory = this.options.accessTokenFactory;

        try {
            if (this.options.skipNegotiation) {
                if (this.options.transport === HttpTransportType.WebSockets) {
                    // No need to add a connection ID in this case
                    this.transport = this.constructTransport(HttpTransportType.WebSockets);
                    // We should just call connect directly in this case.
                    // No fallback or negotiate in this case.
                    await this.transport!.connect(url, transferFormat);
                } else {
                    return Promise.reject(new Error("Negotiation can only be skipped when using the WebSocket transport directly."));
                }
            } else {
                let negotiateResponse: INegotiateResponse | null = null;
                let redirects = 0;

                do {
                    negotiateResponse = await this.getNegotiationResponse(url);
                    // the user tries to stop the connection when it is being started
                    if (this.connectionState === ConnectionState.Disconnected) {
                        return Promise.reject(new Error("The connection was stopped while connecting."));
                    }

                    if (negotiateResponse.error) {
                        return Promise.reject(new Error(negotiateResponse.error));
                    }

                    if ((negotiateResponse as any).ProtocolVersion) {
                        return Promise.reject(new Error("Detected a connection attempt to an ASP.NET SignalR Server. This client only supports connecting to an ASP.NET Core SignalR Server. See https://aka.ms/signalr-core-differences for details."));
                    }

                    if (negotiateResponse.url) {
                        url = negotiateResponse.url;
                    }

                    if (negotiateResponse.accessToken) {
                        // Replace the current access token factory with one that uses
                        // the returned access token
                        const accessToken = negotiateResponse.accessToken;
                        this.accessTokenFactory = () => accessToken;
                    }

                    redirects++;
                }
                while (negotiateResponse.url && redirects < MAX_REDIRECTS);

                if (redirects === MAX_REDIRECTS && negotiateResponse.url) {
                    return Promise.reject(new Error("Negotiate redirection limit exceeded."));
                }

                await this.createTransport(url, this.options.transport, negotiateResponse, transferFormat);
            }

            if (this.transport instanceof LongPollingTransport) {
                this.features.inherentKeepAlive = true;
            }

            this.transport!.onreceive = this.onreceive;

            if (!this.options.reconnectPolicy) {
                this.transport!.onclose = (e) => this.stopConnection(e);
            } else {
                this.transport!.onclose = (e) => this.reconnect(e);
            }

            // Only change the state if we were connecting or reconnecting to not overwrite
            // the state if the connection is already marked as Disconnected.
            if (this.connectionState === ConnectionState.Connecting || this.connectionState === ConnectionState.Reconnecting) {
                this.connectionState = ConnectionState.Connected;
            }
        } catch (e) {
            // Only change state if currently connecting. Don't stop reconnect attempts here.
            if (this.changeState(ConnectionState.Connecting, ConnectionState.Disconnected)) {
                this.logger.log(LogLevel.Error, "Failed to start the connection: " + e);
            }

            this.transport = undefined;
            return Promise.reject(e);
        }
    }

    private async stopTransport(allowReconnect: boolean, error?: Error) {
        // Set error as soon as possible otherwise there is a race between
        // the transport closing and providing an error and the error from a close message
        // We would prefer the close message error.
        this.stopError = error;

        try {
            await this.startPromise;
        } catch (e) {
            // this exception is returned to the user as a rejected Promise from the start method
        }

        // The transport's onclose will trigger stopConnection which will run our onclose event.
        if (this.transport) {
            if (!allowReconnect) {
                // Reset the transport's onclose callback to not call this.reconnect.
                this.transport!.onclose = (e) => this.stopConnection(e);
            }

            await this.transport.stop();
            this.transport = undefined;
        }
    }

    private async getNegotiationResponse(url: string): Promise<INegotiateResponse> {
        let headers;
        if (this.accessTokenFactory) {
            const token = await this.accessTokenFactory();
            if (token) {
                headers = {
                    ["Authorization"]: `Bearer ${token}`,
                };
            }
        }

        const negotiateUrl = this.resolveNegotiateUrl(url);
        this.logger.log(LogLevel.Debug, `Sending negotiation request: ${negotiateUrl}.`);
        try {
            const response = await this.httpClient.post(negotiateUrl, {
                content: "",
                headers,
            });

            if (response.statusCode !== 200) {
                return Promise.reject(new Error(`Unexpected status code returned from negotiate ${response.statusCode}`));
            }

            return JSON.parse(response.content as string) as INegotiateResponse;
        } catch (e) {
            this.logger.log(LogLevel.Error, "Failed to complete negotiation with the server: " + e);
            return Promise.reject(e);
        }
    }

    private createConnectUrl(url: string, connectionId: string | null | undefined) {
        if (!connectionId) {
            return url;
        }
        return url + (url.indexOf("?") === -1 ? "?" : "&") + `id=${connectionId}`;
    }

    private async createTransport(url: string, requestedTransport: HttpTransportType | ITransport | undefined, negotiateResponse: INegotiateResponse, requestedTransferFormat: TransferFormat): Promise<void> {
        let connectUrl = this.createConnectUrl(url, negotiateResponse.connectionId);
        if (this.isITransport(requestedTransport)) {
            this.logger.log(LogLevel.Debug, "Connection was provided an instance of ITransport, using that directly.");
            this.transport = requestedTransport;
            await this.transport.connect(connectUrl, requestedTransferFormat);

            return;
        }

        const transportExceptions: any[] = [];
        const transports = negotiateResponse.availableTransports || [];
        for (const endpoint of transports) {
            try {
                this.connectionState = ConnectionState.Connecting;
                const transport = this.resolveTransport(endpoint, requestedTransport, requestedTransferFormat);
                if (typeof transport === "number") {
                    this.transport = this.constructTransport(transport);
                    if (!negotiateResponse.connectionId) {
                        negotiateResponse = await this.getNegotiationResponse(url);
                        connectUrl = this.createConnectUrl(url, negotiateResponse.connectionId);
                    }
                    await this.transport!.connect(connectUrl, requestedTransferFormat);
                    this.changeState(ConnectionState.Connecting, ConnectionState.Connected);
                    return;
                }
            } catch (ex) {
                this.logger.log(LogLevel.Error, `Failed to start the transport '${endpoint.transport}': ${ex}`);
                negotiateResponse.connectionId = undefined;
                transportExceptions.push(`${endpoint.transport} failed: ${ex}`);
            }
        }

        if (transportExceptions.length > 0) {
            return Promise.reject(new Error(`Unable to connect to the server with any of the available transports. ${transportExceptions.join(" ")}`));
        }
        return Promise.reject(new Error("None of the transports supported by the client are supported by the server."));
    }

    private constructTransport(transport: HttpTransportType) {
        switch (transport) {
            case HttpTransportType.WebSockets:
                if (!this.options.WebSocket) {
                    throw new Error("'WebSocket' is not supported in your environment.");
                }
                return new WebSocketTransport(this.httpClient, this.accessTokenFactory, this.logger, this.options.logMessageContent || false, this.options.WebSocket);
            case HttpTransportType.ServerSentEvents:
                if (!this.options.EventSource) {
                    throw new Error("'EventSource' is not supported in your environment.");
                }
                return new ServerSentEventsTransport(this.httpClient, this.accessTokenFactory, this.logger, this.options.logMessageContent || false, this.options.EventSource);
            case HttpTransportType.LongPolling:
                return new LongPollingTransport(this.httpClient, this.accessTokenFactory, this.logger, this.options.logMessageContent || false);
            default:
                throw new Error(`Unknown transport: ${transport}.`);
        }
    }

    private resolveTransport(endpoint: IAvailableTransport, requestedTransport: HttpTransportType | undefined, requestedTransferFormat: TransferFormat): HttpTransportType | null {
        const transport = HttpTransportType[endpoint.transport];
        if (transport === null || transport === undefined) {
            this.logger.log(LogLevel.Debug, `Skipping transport '${endpoint.transport}' because it is not supported by this client.`);
        } else {
            const transferFormats = endpoint.transferFormats.map((s) => TransferFormat[s]);
            if (transportMatches(requestedTransport, transport)) {
                if (transferFormats.indexOf(requestedTransferFormat) >= 0) {
                    if ((transport === HttpTransportType.WebSockets && !this.options.WebSocket) ||
                        (transport === HttpTransportType.ServerSentEvents && !this.options.EventSource)) {
                        this.logger.log(LogLevel.Debug, `Skipping transport '${HttpTransportType[transport]}' because it is not supported in your environment.'`);
                        throw new Error(`'${HttpTransportType[transport]}' is not supported in your environment.`);
                    } else {
                        this.logger.log(LogLevel.Debug, `Selecting transport '${HttpTransportType[transport]}'.`);
                        return transport;
                    }
                } else {
                    this.logger.log(LogLevel.Debug, `Skipping transport '${HttpTransportType[transport]}' because it does not support the requested transfer format '${TransferFormat[requestedTransferFormat]}'.`);
                    throw new Error(`'${HttpTransportType[transport]}' does not support ${TransferFormat[requestedTransferFormat]}.`);
                }
            } else {
                this.logger.log(LogLevel.Debug, `Skipping transport '${HttpTransportType[transport]}' because it was disabled by the client.`);
                throw new Error(`'${HttpTransportType[transport]}' is disabled by the client.`);
            }
        }
        return null;
    }

    private isITransport(transport: any): transport is ITransport {
        return transport && typeof (transport) === "object" && "connect" in transport;
    }

    private changeState(from: ConnectionState, to: ConnectionState): boolean {
        if (this.connectionState === from) {
            this.connectionState = to;
            return true;
        }
        return false;
    }

    private stopConnection(error?: Error): void {
        this.transport = undefined;

        // If we have a stopError, it takes precedence over the error from the transport
        error = this.stopError || error;

        if (error) {
            this.logger.log(LogLevel.Error, `Connection disconnected with error '${error}'.`);
        } else {
            this.logger.log(LogLevel.Information, "Connection disconnected.");
        }

        this.connectionState = ConnectionState.Disconnected;

        if (this.onclose) {
            this.onclose(error);
        }
    }

    private async reconnect(error?: Error) {
        try {
            await this.startPromise;
        } catch (e) {
            // This exception is returned to the user as a rejected Promise from the start method
            // or was observed by the last reconnect loop.
        }

        const reconnectPolicy = this.options.reconnectPolicy as IReconnectPolicy;
        let previousRetryCount = 0;
        let nextRetryDelay = reconnectPolicy.nextRetryDelayInMilliseconds(previousRetryCount++, 0);

        if (nextRetryDelay === null) {
            this.logger.log(LogLevel.Information, "Connection not reconnecting because of the IReconnectPolicy.");
            this.stopConnection(error);
            return;
        }

        if (!this.changeState(ConnectionState.Connected, ConnectionState.Reconnecting)) {
            return;
        }

        if (error) {
            this.logger.log(LogLevel.Information, `Connection reconnecting because of error '${error}'.`);
        } else {
            this.logger.log(LogLevel.Information, "Connection reconnecting.");
        }

        if (this.onreconnecting) {
            this.onreconnecting(error);

            // Exit early if the onreconnecting callback called connection.stop().
            if (this.connectionState !== ConnectionState.Reconnecting) {
                return;
            }
        }

        const startTime = Date.now();

        while (nextRetryDelay != null) {
            this.logger.log(LogLevel.Information, `The next reconnect attempt will start in ${nextRetryDelay} ms.`);
            await new Promise((resolve) => setTimeout(resolve, nextRetryDelay as number));

            if (this.connectionState !== ConnectionState.Reconnecting) {
                return;
            }

            try {
                await this.startInternal(this.transferFormat as TransferFormat);

                // The TypeScript compiler thinks that this.connectionState is always Reconnecting here meaning this condition is always false.
                // The TypeScript compiler is wrong.
                if ((this.connectionState as any) === ConnectionState.Connected) {
                    this.logger.log(LogLevel.Information, "Connection reconnected.");

                    if (this.onreconnected) {
                        this.onreconnected();
                    }
                }

                return;
            } catch (e) {
                this.logger.log(LogLevel.Information, `Reconnect attempt failed because of error '${e}'.`);

                if (this.connectionState !== ConnectionState.Reconnecting) {
                    return;
                }
            }

            nextRetryDelay = reconnectPolicy.nextRetryDelayInMilliseconds(previousRetryCount++, Date.now() - startTime);
        }

        this.logger.log(LogLevel.Information, "Reconnect retry attempts have been exhausted. Connection disconnecting.");

        this.stopConnection();
    }

    private resolveUrl(url: string): string {
        // startsWith is not supported in IE
        if (url.lastIndexOf("https://", 0) === 0 || url.lastIndexOf("http://", 0) === 0) {
            return url;
        }

        if (!Platform.isBrowser || !window.document) {
            throw new Error(`Cannot resolve '${url}'.`);
        }

        // Setting the url to the href propery of an anchor tag handles normalization
        // for us. There are 3 main cases.
        // 1. Relative  path normalization e.g "b" -> "http://localhost:5000/a/b"
        // 2. Absolute path normalization e.g "/a/b" -> "http://localhost:5000/a/b"
        // 3. Networkpath reference normalization e.g "//localhost:5000/a/b" -> "http://localhost:5000/a/b"
        const aTag = window.document.createElement("a");
        aTag.href = url;

        this.logger.log(LogLevel.Information, `Normalizing '${url}' to '${aTag.href}'.`);
        return aTag.href;
    }

    private resolveNegotiateUrl(url: string): string {
        const index = url.indexOf("?");
        let negotiateUrl = url.substring(0, index === -1 ? url.length : index);
        if (negotiateUrl[negotiateUrl.length - 1] !== "/") {
            negotiateUrl += "/";
        }
        negotiateUrl += "negotiate";
        negotiateUrl += index === -1 ? "" : url.substring(index);
        return negotiateUrl;
    }
}

function transportMatches(requestedTransport: HttpTransportType | undefined, actualTransport: HttpTransportType) {
    return !requestedTransport || ((actualTransport & requestedTransport) !== 0);
}
