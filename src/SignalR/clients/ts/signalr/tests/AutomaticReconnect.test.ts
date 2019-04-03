// Copyright (c) .NET Foundation. All rights reserved.
// Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.

import { DefaultReconnectPolicy } from "../src/DefaultReconnectPolicy";
import { HttpConnection } from "../src/HttpConnection";
import { IHttpConnectionOptions } from "../src/IHttpConnectionOptions";
import { HttpTransportType, TransferFormat } from "../src/ITransport";
import { NullLogger } from "../src/Loggers";
import { WebSocketConstructor } from "../src/Polyfills";

import { VerifyLogger } from "./Common";
import { TestHttpClient } from "./TestHttpClient";
import { TestCloseEvent, TestEvent, TestWebSocket } from "./TestWebSocket";
import { defaultNegotiateResponse, PromiseSource } from "./Utils";
import { TestEventSource, TestMessageEvent } from "./TestEventSource";

const commonOptions: IHttpConnectionOptions = {
    logger: NullLogger.instance,
};

describe("auto reconnect", () => {
    it("is not enabled by default", async () => {
        let negotiateCount = 0;

        await VerifyLogger.run(async (loggerImpl) => {
            const options: IHttpConnectionOptions = {
                ...commonOptions,
                httpClient: new TestHttpClient()
                    .on("POST", () => {
                        negotiateCount++;
                        return defaultNegotiateResponse;
                    }),
                transport: HttpTransportType.WebSockets,
                WebSocket: TestWebSocket,
                logger: loggerImpl,
            } as IHttpConnectionOptions;

            const closePromise = new PromiseSource();
            let onreconnectingCalled = false;

            const connection = new HttpConnection("http://tempuri.org", options);

            TestWebSocket.webSocketSet = new PromiseSource();

            const startPromise = connection.start(TransferFormat.Text);

            await TestWebSocket.webSocketSet;
            await TestWebSocket.webSocket.openSet;

            TestWebSocket.webSocket.onopen(new TestEvent());

            await startPromise;

            connection.onclose = (e) => {
                closePromise.resolve();
            };

            connection.onreconnecting = (e) => {
                onreconnectingCalled = true;
            };

            TestWebSocket.webSocket.onclose(new TestCloseEvent());

            await closePromise;

            expect(onreconnectingCalled).toBe(false);
            expect(negotiateCount).toBe(1);

        },
        "Connection disconnected with error 'Error: WebSocket closed with status code: 0 ().'.");
    });

    it("can be opted into", async () => {
        let negotiateCount = 0;

        await VerifyLogger.run(async (loggerImpl) => {
            const options: IHttpConnectionOptions = {
                ...commonOptions,
                httpClient: new TestHttpClient()
                    .on("POST", () => {
                        negotiateCount++;
                        return defaultNegotiateResponse;
                    }),
                transport: HttpTransportType.WebSockets,
                WebSocket: TestWebSocket,
                logger: loggerImpl,
                reconnectPolicy: new DefaultReconnectPolicy()
            } as IHttpConnectionOptions;

            const reconnectingPromise = new PromiseSource();
            const reconnectedPromise = new PromiseSource();
            let oncloseCalled = false;
            let onreconnectingCallCount = 0;

            const connection = new HttpConnection("http://tempuri.org", options);

            TestWebSocket.webSocketSet = new PromiseSource();

            const startPromise = connection.start(TransferFormat.Text);

            await TestWebSocket.webSocketSet;
            await TestWebSocket.webSocket.openSet;

            TestWebSocket.webSocket.onopen(new TestEvent());

            await startPromise;

            connection.onclose = (e) => {
                oncloseCalled = true;
            };

            connection.onreconnecting = (e) => {
                onreconnectingCallCount++;
                reconnectingPromise.resolve();
            };

            connection.onreconnected = (connectionId) => {
                reconnectedPromise.resolve();
            };

            TestWebSocket.webSocketSet = new PromiseSource();

            TestWebSocket.webSocket.onclose(new TestCloseEvent());

            await reconnectingPromise;

            await TestWebSocket.webSocketSet;
            await TestWebSocket.webSocket.openSet;

            TestWebSocket.webSocket.onopen(new TestEvent());

            await reconnectedPromise;

            expect(onreconnectingCallCount).toBe(1);
            expect(oncloseCalled).toBe(false);

            await connection.stop();

            expect(onreconnectingCallCount).toBe(1);
            expect(oncloseCalled).toBe(true);

            expect(negotiateCount).toBe(2);

        },
        "Connection disconnected with error 'Error: WebSocket closed with status code: 0 ().'.");
    });

    it("can be triggered by calling connectionLost()", async () => {
        await VerifyLogger.run(async (loggerImpl) => {
            const options: IHttpConnectionOptions = {
                ...commonOptions,
                httpClient: new TestHttpClient().on("POST", () => defaultNegotiateResponse),
                transport: HttpTransportType.WebSockets,
                WebSocket: TestWebSocket,
                logger: loggerImpl,
                reconnectPolicy: new DefaultReconnectPolicy()
            } as IHttpConnectionOptions;

            const reconnectingPromise = new PromiseSource();
            const reconnectedPromise = new PromiseSource();
            let oncloseCalled = false;
            let onreconnectingCallCount = 0;

            const connection = new HttpConnection("http://tempuri.org", options);

            TestWebSocket.webSocketSet = new PromiseSource();

            const startPromise = connection.start(TransferFormat.Text);

            await TestWebSocket.webSocketSet;
            await TestWebSocket.webSocket.openSet;

            TestWebSocket.webSocket.onopen(new TestEvent());

            await startPromise;

            connection.onclose = (e) => {
                oncloseCalled = true;
            };

            connection.onreconnecting = (e) => {
                onreconnectingCallCount++;
                reconnectingPromise.resolve();
            };

            connection.onreconnected = (connectionId) => {
                reconnectedPromise.resolve();
            };

            TestWebSocket.webSocketSet = new PromiseSource();

            connection.connectionLost(new Error());

            await reconnectingPromise;

            await TestWebSocket.webSocketSet;
            await TestWebSocket.webSocket.openSet;

            TestWebSocket.webSocket.onopen(new TestEvent());

            await reconnectedPromise;

            expect(onreconnectingCallCount).toBe(1);
            expect(oncloseCalled).toBe(false);

            await connection.stop();

            expect(onreconnectingCallCount).toBe(1);
            expect(oncloseCalled).toBe(true);

        },
        "Connection disconnected with error 'Error: WebSocket closed with status code: 0 ().'.");
    });

    it("will attempt to use all available transports", async () => {
        await VerifyLogger.run(async (loggerImpl) => {
            const options: IHttpConnectionOptions = {
                ...commonOptions,
                httpClient: new TestHttpClient().on("POST", () => defaultNegotiateResponse),
                WebSocket: TestWebSocket,
                EventSource: TestEventSource,
                logger: loggerImpl,
                reconnectPolicy: new DefaultReconnectPolicy()
            } as IHttpConnectionOptions;

            const reconnectingPromise = new PromiseSource();
            const reconnectedPromise = new PromiseSource();
            let oncloseCalled = false;
            let onreconnectingCallCount = 0;

            const connection = new HttpConnection("http://tempuri.org", options);

            TestWebSocket.webSocketSet = new PromiseSource();

            const startPromise = connection.start(TransferFormat.Text);

            await TestWebSocket.webSocketSet;
            await TestWebSocket.webSocket.openSet;

            TestWebSocket.webSocket.onopen(new TestEvent());

            await startPromise;

            connection.onclose = (e) => {
                oncloseCalled = true;
            };

            connection.onreconnecting = (e) => {
                onreconnectingCallCount++;
                reconnectingPromise.resolve();
            };

            connection.onreconnected = (connectionId) => {
                reconnectedPromise.resolve();
            };

            TestWebSocket.webSocketSet = new PromiseSource();
            TestEventSource.eventSourceSet = new PromiseSource();

            TestWebSocket.webSocket.onclose(new TestCloseEvent());

            await reconnectingPromise;

            await TestWebSocket.webSocketSet;
            await TestWebSocket.webSocket.openSet;

            TestWebSocket.webSocket.onerror(new TestEvent());

            await TestEventSource.eventSourceSet;
            await TestEventSource.eventSource.openSet;
            TestEventSource.eventSource.onopen(new TestMessageEvent());

            await reconnectedPromise;

            expect(onreconnectingCallCount).toBe(1);
            expect(oncloseCalled).toBe(false);

            await connection.stop();

            expect(onreconnectingCallCount).toBe(1);
            expect(oncloseCalled).toBe(true);

        },
        "Connection disconnected with error 'Error: WebSocket closed with status code: 0 ().'.",
        "Failed to start the transport 'WebSockets': null");
    });
});
