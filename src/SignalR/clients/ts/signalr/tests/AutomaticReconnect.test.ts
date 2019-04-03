// Copyright (c) .NET Foundation. All rights reserved.
// Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.

// import { HubConnection } from "../src/HubConnection";

// function createHubConnection(connection: IConnectionThisIsFake, logger?: ILogger | null, protocol?: IHubProtocol | null) {
//     return HubConnection.create(connection, logger || NullLogger.instance, protocol || new JsonHubProtocol());
// }

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

const commonOptions: IHttpConnectionOptions = {
    logger: NullLogger.instance,
};

describe("auto reconnect", () => {
    it("is not enabled by default", async () => {
        await VerifyLogger.run(async (loggerImpl) => {
            const options: IHttpConnectionOptions = {
                ...commonOptions,
                WebSocket: TestWebSocket as WebSocketConstructor,
                httpClient: new TestHttpClient()
                    .on("POST", () => defaultNegotiateResponse),
                logger: loggerImpl,
                transport: HttpTransportType.WebSockets,
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

        }, "Connection disconnected with error 'Error: WebSocket closed with status code: 0 ().'.");
    });

    it("can be opted into", async () => {
        await VerifyLogger.run(async (loggerImpl) => {
            const options: IHttpConnectionOptions = {
                ...commonOptions,
                WebSocket: TestWebSocket as WebSocketConstructor,
                httpClient: new TestHttpClient()
                    .on("POST", () => defaultNegotiateResponse),
                logger: loggerImpl,
                transport: HttpTransportType.WebSockets,
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

        }, "Connection disconnected with error 'Error: WebSocket closed with status code: 0 ().'.");
    });

    it("can be triggered by calling connectionLost()", async () => {
        await VerifyLogger.run(async (loggerImpl) => {
            const options: IHttpConnectionOptions = {
                ...commonOptions,
                WebSocket: TestWebSocket as WebSocketConstructor,
                httpClient: new TestHttpClient()
                    .on("POST", () => defaultNegotiateResponse),
                logger: loggerImpl,
                transport: HttpTransportType.WebSockets,
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

        }, "Connection disconnected with error 'Error: WebSocket closed with status code: 0 ().'.");
    });
});
