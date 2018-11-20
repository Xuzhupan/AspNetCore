// Copyright (c) .NET Foundation. All rights reserved.
// Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.

using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using OpenQA.Selenium;
using Templates.Test.Helpers;
using Xunit;
using Xunit.Abstractions;

namespace Microsoft.AspNetCore.E2ETesting
{
    [CaptureSeleniumLogs]
    public class BrowserTestBase : IClassFixture<BrowserFixture>, IAsyncLifetime
    {
        private static readonly AsyncLocal<IWebDriver> _asyncBrowser = new AsyncLocal<IWebDriver>();
        private static readonly AsyncLocal<ILogs> _logs = new AsyncLocal<ILogs>();
        private static readonly AsyncLocal<ITestOutputHelper> _output = new AsyncLocal<ITestOutputHelper>();

        public BrowserTestBase(BrowserFixture browserFixture, ITestOutputHelper output)
        {
            BrowserFixture = browserFixture;
            _output.Value = output;
        }

        public IWebDriver Browser { get; set; }

        public static IWebDriver BrowserAccessor => _asyncBrowser.Value;

        public static ILogs Logs => _logs.Value;

        public static ITestOutputHelper Output => _output.Value;

        public BrowserFixture BrowserFixture { get; }

        public Task DisposeAsync()
        {
            return Task.CompletedTask;
        }

        public virtual async Task InitializeAsync()
        {
            var (browser, logs) = await BrowserFixture.GetOrCreateBrowserAsync(Output);
            _asyncBrowser.Value = browser;
            _logs.Value = logs;

            Browser = browser;

            InitializeAsyncCore();
        }

        protected static IList<string> NoAuthUrls = new List<string> {
            "/",
            "/Privacy"
        };

        protected static IList<string> AuthUrls = new List<string> {
            "/",
            "/Privacy",
            "/Identity/Account/Login",
            "/Identity/Account/Register"
        };

        public BrowserTestBase(BrowserFixture browserFixture, ITestOutputHelper output) : base(output)
        {
        }


        protected void TestBasicNavigation(AspNetProcess aspnetProcess, IEnumerable<string> urls)
        {
            foreach (var url in urls)
            {
                aspnetProcess.AssertOk(url);
            }

            var logs = new List<IReadOnlyCollection<LogEntry>>()
            {
                _logs.Value.GetLog(LogType.Browser),
                _logs.Value.GetLog(LogType.Client)
            };

            foreach(var log in logs)
            {
                Assert.True(!log.Any(l => IsBadMessage(l)),  "There should have been no log messages of warning or higher.");
            }
        }

        private bool IsBadMessage(LogEntry entry)
        {
            return entry.Level == LogLevel.Warning || entry.Level == LogLevel.Severe;
        }
    }
}
