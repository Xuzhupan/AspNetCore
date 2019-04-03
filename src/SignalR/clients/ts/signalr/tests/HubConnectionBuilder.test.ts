// Copyright (c) .NET Foundation. All rights reserved.
// Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.

import { HttpRequest, HttpResponse } from "../src/HttpClient";
import { HubConnection } from "../src/HubConnection";
import { HubConnectionBuilder } from "../src/HubConnectionBuilder";
import { IHttpConnectionOptions } from "../src/IHttpConnectionOptions";
import { HubMessage, IHubProtocol } from "../src/IHubProtocol";
import { ILogger, LogLevel } from "../src/ILogger";
import { HttpTransportType, TransferFormat } from "../src/ITransport";
import { NullLogger } from "../src/Loggers";

import { VerifyLogger } from "./Common";
import { TestHttpClient } from "./TestHttpClient";
import { PromiseSource, registerUnhandledRejectionHandler } from "./Utils";

const longPollingNegotiateResponse = {
    availableTransports: [
        { transport: "LongPolling", transferFormats: ["Text", "Binary"] },
    ],
    connectionId: "abc123",
};

const commonHttpOptions: IHttpConnectionOptions = {
    logMessageContent: true,
};

registerUnhandledRejectionHandler();

describe("HubConnectionBuilder", () => {
    eachMissingValue((val, name) => {
        it(`configureLogging throws if logger is ${name}`, () => {
            const builder = new HubConnectionBuilder();
            expect(() => builder.configureLogging(val!)).toThrow("The 'logging' argument is required.");
        });

        it(`withUrl throws if url is ${name}`, () => {
            const builder = new HubConnectionBuilder();
            expect(() => builder.withUrl(val!)).toThrow("The 'url' argument is required.");
        });

        it(`withHubProtocol throws if protocol is ${name}`, () => {
            const builder = new HubConnectionBuilder();
            expect(() => builder.withHubProtocol(val!)).toThrow("The 'protocol' argument is required.");
        });
    });

    it("builds HubConnection with HttpConnection using provided URL", async () => {
        await VerifyLogger.run(async (logger) => {
            const pollSent = new PromiseSource<HttpRequest>();
            const pollCompleted = new PromiseSource<HttpResponse>();
            const testClient = createTestClient(pollSent, pollCompleted.promise)
                .on("POST", "http://example.com?id=abc123", (req) => {
                    // Respond from the poll with the handshake response
                    pollCompleted.resolve(new HttpResponse(204, "No Content", "{}"));
                    return new HttpResponse(202);
                });
            const connection = createConnectionBuilder()
                .withUrl("http://example.com", {
                    ...commonHttpOptions,
                    httpClient: testClient,
                    logger,
                })
                .build();

            // Start the connection
            const closed = makeClosedPromise(connection);

            const startPromise = connection.start();

            const pollRequest = await pollSent.promise;
            expect(pollRequest.url).toMatch(/http:\/\/example.com\?id=abc123.*/);

            await closed;
            try {
                await startPromise;
            } catch { }
        });
    });

    it("can configure transport type", async () => {
        const protocol = new TestProtocol();

        const builder = createConnectionBuilder()
            .withUrl("http://example.com", HttpTransportType.WebSockets)
            .withHubProtocol(protocol);
        expect(builder.httpConnectionOptions!.transport).toBe(HttpTransportType.WebSockets);
    });

    it("can configure hub protocol", async () => {
        await VerifyLogger.run(async (logger) => {
            const protocol = new TestProtocol();

            const pollSent = new PromiseSource<HttpRequest>();
            const pollCompleted = new PromiseSource<HttpResponse>();
            const negotiateReceived = new PromiseSource<HttpRequest>();
            const testClient = createTestClient(pollSent, pollCompleted.promise)
                .on("POST", "http://example.com?id=abc123", (req) => {
                    // Respond from the poll with the handshake response
                    negotiateReceived.resolve(req);
                    pollCompleted.resolve(new HttpResponse(204, "No Content", "{}"));
                    return new HttpResponse(202);
                });

            const connection = createConnectionBuilder()
                .withUrl("http://example.com", {
                    ...commonHttpOptions,
                    httpClient: testClient,
                    logger,
                })
                .withHubProtocol(protocol)
                .build();

            // Start the connection
            const closed = makeClosedPromise(connection);

            const startPromise = connection.start();

            const negotiateRequest = await negotiateReceived.promise;
            expect(negotiateRequest.content).toBe(`{"protocol":"${protocol.name}","version":1}\x1E`);

            await closed;
            try {
                await startPromise;
            } catch { }
        });
    });

    it("allows logger to be replaced", async () => {
        let loggedMessages = 0;
        const logger = {
            log() {
                loggedMessages += 1;
            },
        };
        const pollSent = new PromiseSource<HttpRequest>();
        const pollCompleted = new PromiseSource<HttpResponse>();
        const testClient = createTestClient(pollSent, pollCompleted.promise)
            .on("POST", "http://example.com?id=abc123", (req) => {
                // Respond from the poll with the handshake response
                pollCompleted.resolve(new HttpResponse(204, "No Content", "{}"));
                return new HttpResponse(202);
            });
        const connection = createConnectionBuilder(logger)
            .withUrl("http://example.com", {
                ...commonHttpOptions,
                httpClient: testClient,
            })
            .build();

        try {
            await connection.start();
        } catch {
            // Ignore failures
        }

        expect(loggedMessages).toBeGreaterThan(0);
    });

    it("uses logger for both HttpConnection and HubConnection", async () => {
        const pollSent = new PromiseSource<HttpRequest>();
        const pollCompleted = new PromiseSource<HttpResponse>();
        const testClient = createTestClient(pollSent, pollCompleted.promise)
            .on("POST", "http://example.com?id=abc123", (req) => {
                // Respond from the poll with the handshake response
                pollCompleted.resolve(new HttpResponse(204, "No Content", "{}"));
                return new HttpResponse(202);
            });
        const logger = new CaptureLogger();
        const connection = createConnectionBuilder(logger)
            .withUrl("http://example.com", {
                ...commonHttpOptions,
                httpClient: testClient,
            })
            .build();

        try {
            await connection.start();
        } catch {
            // Ignore failures
        }

        // A HubConnection message
        expect(logger.messages).toContain("Starting HubConnection.");

        // An HttpConnection message
        expect(logger.messages).toContain("Starting connection with transfer format 'Text'.");
    });

    it("does not replace HttpConnectionOptions logger if provided", async () => {
        const pollSent = new PromiseSource<HttpRequest>();
        const pollCompleted = new PromiseSource<HttpResponse>();
        const testClient = createTestClient(pollSent, pollCompleted.promise)
            .on("POST", "http://example.com?id=abc123", (req) => {
                // Respond from the poll with the handshake response
                pollCompleted.resolve(new HttpResponse(204, "No Content", "{}"));
                return new HttpResponse(202);
            });
        const hubConnectionLogger = new CaptureLogger();
        const httpConnectionLogger = new CaptureLogger();
        const connection = createConnectionBuilder(hubConnectionLogger)
            .withUrl("http://example.com", {
                httpClient: testClient,
                logger: httpConnectionLogger,
            })
            .build();

        try {
            await connection.start();
        } catch {
            // Ignore failures
        }

        // A HubConnection message
        expect(hubConnectionLogger.messages).toContain("Starting HubConnection.");
        expect(httpConnectionLogger.messages).not.toContain("Starting HubConnection.");

        // An HttpConnection message
        expect(httpConnectionLogger.messages).toContain("Starting connection with transfer format 'Text'.");
        expect(hubConnectionLogger.messages).not.toContain("Starting connection with transfer format 'Text'.");
    });

    it("reconnectPolicy undefined by default", () => {
        const builder = new HubConnectionBuilder().withUrl("http://example.com");
        expect(builder.httpConnectionOptions!.reconnectPolicy).toBeUndefined();
    });

    it("withAutomaticReconnect throws is reconnectPolicy is already set", () => {
        const builder = new HubConnectionBuilder().withAutomaticReconnect();
        expect(() => builder.withAutomaticReconnect()).toThrow("this.httpConnectionOptions.reconnectPolicy has already been set.");
    });

    it("reconnectPolicy preserved if set before transportType via withUrl", () => {
        const builder = new HubConnectionBuilder()
            .withAutomaticReconnect()
            .withUrl("http://example.com", HttpTransportType.WebSockets);

        expect(builder.httpConnectionOptions!.reconnectPolicy).toBeDefined();
        expect(builder.httpConnectionOptions!.transport).toBe(HttpTransportType.WebSockets);
    });

    it("reconnectPolicy preserved if set before httpConnectionOptions via withUrl", () => {
        const builder = new HubConnectionBuilder()
            .withAutomaticReconnect()
            .withUrl("http://example.com", {
                ...commonHttpOptions,
                transport: HttpTransportType.WebSockets,
            });

        expect(builder.httpConnectionOptions!.reconnectPolicy).toBeDefined();
        expect(builder.httpConnectionOptions!.transport).toBe(HttpTransportType.WebSockets);
    });

    it("httpConnectionOptions preserved if set before withAutomaticReconnect", () => {
        const builder = new HubConnectionBuilder()
            .withUrl("http://example.com", {
                ...commonHttpOptions,
                transport: HttpTransportType.WebSockets,
            })
            .withAutomaticReconnect();

        expect(builder.httpConnectionOptions!.transport).toBe(HttpTransportType.WebSockets);
        expect(builder.httpConnectionOptions!.reconnectPolicy).toBeDefined();
    });

    it("withAutomaticReconnect uses default retryDelays when called with no arguments", () => {
        // From DefaultReconnectPolicy.ts
        const DEFAULT_RETRY_DELAYS_IN_MILLISECONDS = [0, 2000, 10000, 30000, null];
        const builder = new HubConnectionBuilder()
            .withAutomaticReconnect();

        let retryCount = 0;
        for (const delay of DEFAULT_RETRY_DELAYS_IN_MILLISECONDS) {
            expect(builder.httpConnectionOptions!.reconnectPolicy!.nextRetryDelayInMilliseconds(retryCount++, 0)).toBe(delay);
        }
    });

    it("withAutomaticReconnect uses custom retryDelays when provided", () => {
        const customRetryDelays = [ 3, 1, 4, 1, 5, 9 ];
        const builder = new HubConnectionBuilder()
            .withAutomaticReconnect(customRetryDelays);

        let retryCount = 0;
        for (const delay of customRetryDelays) {
            expect(builder.httpConnectionOptions!.reconnectPolicy!.nextRetryDelayInMilliseconds(retryCount++, 0)).toBe(delay);
        }

        expect(builder.httpConnectionOptions!.reconnectPolicy!.nextRetryDelayInMilliseconds(retryCount, 0)).toBe(null);
    });
});

class CaptureLogger implements ILogger {
    public readonly messages: string[] = [];

    public log(logLevel: LogLevel, message: string): void {
        this.messages.push(message);
    }
}

class TestProtocol implements IHubProtocol {
    public name: string = "test";
    public version: number = 1;
    public transferFormat: TransferFormat = TransferFormat.Text;
    public parseMessages(input: string | ArrayBuffer, logger: ILogger): HubMessage[] {
        throw new Error("Method not implemented.");
    }
    public writeMessage(message: HubMessage): string | ArrayBuffer {
        // builds ping message in the `hubConnection` constructor
        return "";
    }
}

function createConnectionBuilder(logger?: ILogger): HubConnectionBuilder {
    // We don't want to spam test output with logs. This can be changed as needed
    return new HubConnectionBuilder()
        .configureLogging(logger || NullLogger.instance);
}

function createTestClient(pollSent: PromiseSource<HttpRequest>, pollCompleted: Promise<HttpResponse>, negotiateResponse?: any): TestHttpClient {
    let firstRequest = true;
    return new TestHttpClient()
        .on("POST", "http://example.com/negotiate", () => negotiateResponse || longPollingNegotiateResponse)
        .on("GET", /http:\/\/example.com\?id=abc123&_=.*/, (req) => {
            if (firstRequest) {
                firstRequest = false;
                return new HttpResponse(200);
            } else {
                pollSent.resolve(req);
                return pollCompleted;
            }
        });
}

function makeClosedPromise(connection: HubConnection): Promise<void> {
    const closed = new PromiseSource();
    connection.onclose((error) => {
        if (error) {
            closed.reject(error);
        } else {
            closed.resolve();
        }
    });
    return closed.promise;
}

function eachMissingValue(callback: (val: undefined | null, name: string) => void) {
    callback(null, "null");
    callback(undefined, "undefined");
}
