const cases = [
  {
    case_id: 'case-001',
    expected_category: '[0] 網路/推流品質',
    expected_keywords: ['卡', '斷續', 'Poor CDN Connection'],
    evalConfig: { modelName: 'gemini-2.5-pro', temperature: 0.1 },
    aggregateData: [
      {
        liveStreamID: '213754852',
        details: [
          {
            liveStreamID: '213754852',
            type: 'dialogue',
            dialogue: '[21:04:10] [streamer]: 畫面有點卡\n[21:04:15] [viewer]: 聲音斷斷續續'
          },
          {
            liveStreamID: '213754852',
            type: 'streamerLog',
            conditions: [],
            filterLogs: [
              {
                conditionID: 'bitrate_fail',
                description: 'Bitrate CV > 0.3',
                lineNumber: 1,
                timestamp: '2025-12-21T21:04:15',
                dataSnippet: {
                  BitrateCV: '0.72',
                  PingMax: '999.0',
                  UnsentCountMax: '158.0',
                  NetworkType: 'WiFi'
                }
              }
            ]
          },
          {
            liveStreamID: '213754852',
            type: 'streamEventLog',
            conditions: [],
            filterLogs: [
              {
                lineNumber: 1,
                timestamp: '2025-12-21T21:04:12',
                title: 'Poor CDN Connection',
                Log: '{"time":"21:04:12","title":"Poor CDN Connection"}'
              }
            ]
          },
          {
            type: 'streamInfo',
            liveStreamID: '213754852',
            streamInfo: [
              {
                liveStreamID: '213754852',
                closeBy: 'normalEnd',
                deviceModel: 'iPhone 13',
                type: 'iOS',
                version: '3.260.0',
                ipRegion: 'JP'
              }
            ]
          }
        ],
        count: 4
      }
    ]
  },
  {
    case_id: 'case-002',
    expected_category: '[3] 無資料/無法判定',
    expected_keywords: ['無資料', '查無'],
    evalConfig: { modelName: 'gemini-3.0-pro-preview', temperature: 0.1 },
    aggregateData: []
  }
];

return cases.map((item) => ({ json: item }));