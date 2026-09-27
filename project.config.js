module.exports = {
  port: 3912,
  title: '钟乳石洞穴微环境巡测',
  lede: '围绕洞穴、分区、样点和巡测路线记录微环境数据；繁殖季登记蝠群夜出，幼蝠占比或弃飞触发封护，复核达标自动解除。',
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '读数正常': 'ok',
    '重点保护': 'warn',
    '异常待复查': 'bad',
    '触发封护': 'bad',
    '封护': 'bad',
    '暂停开放': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' },
    emergences: { label: '夜出记录' },
    settings: { label: '判定设置' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '封护中', collection: 'sites', filter: { field: 'protectedStatus', value: '封护' } },
    { label: '重点保护', collection: 'sites', filter: { field: 'protectedStatus', value: '重点保护' } },
    { label: '夜出记录', collection: 'emergences' },
    { label: '待复查', collection: 'surveys', filter: { field: 'status', value: '异常待复查' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '趋势看板',
      type: 'dashboard',
      panels: [
        { title: '今晚不可进洞（封护/暂停开放）', collection: 'sites', field: 'protectedStatus', values: ['封护', '暂停开放'], limit: 8 },
        { title: '异常与复查', collection: 'surveys', field: 'status', values: ['异常待复查'], limit: 8 }
      ]
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '封护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' },
        { label: '封护复核', compute: 'sealProgress' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准温度', name: 'baselineTemp', type: 'number', required: true },
        { label: '基准湿度', name: 'baselineHumidity', type: 'number', required: true },
        { label: '基准CO2', name: 'baselineCo2', type: 'number', required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'emergences',
      label: '夜出台',
      collection: 'emergences',
      formTitle: '登记夜出',
      listTitle: '夜出记录',
      submitLabel: '保存夜出',
      searchPlaceholder: '搜索观察员、备注',
      searchFields: ['observer', 'note'],
      statusField: 'judgment',
      statusOptions: ['触发封护', '读数正常'],
      titleFields: ['observer', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['note'],
      detailFields: [
        { label: '成蝠数', name: 'adultCount' },
        { label: '幼蝠数', name: 'juvenileCount' },
        { label: '幼蝠占比', name: 'juvenileRatio', suffix: '%' },
        { label: '温度', name: 'temperature' },
        { label: '弃飞', name: 'abandonedFlight' }
      ],
      threshold: { settingsId: 'settings-emergence', field: 'juvenileRatioThreshold' },
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '观察员', name: 'observer', required: true },
        { label: '成蝠数', name: 'adultCount', type: 'number', required: true },
        { label: '幼蝠数', name: 'juvenileCount', type: 'number', required: true },
        { label: '温度', name: 'temperature', type: 'number', required: true },
        { label: '弃飞', name: 'abandonedFlight', type: 'select', options: ['无', '有'] },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测记录',
      collection: 'surveys',
      formTitle: '登记巡测',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、干扰痕迹、照片',
      searchFields: ['surveyor', 'disturbance', 'photoUrl'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '已复查'],
      titleFields: ['surveyor', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['disturbance', 'reviewNote'],
      detailFields: [
        { label: '温度', name: 'temperature' },
        { label: '湿度', name: 'humidity' },
        { label: 'CO2', name: 'co2' }
      ],
      defaults: { status: '正常', reviewNote: '' },
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '温度', name: 'temperature', type: 'number', required: true },
        { label: '湿度', name: 'humidity', type: 'number', required: true },
        { label: 'CO2', name: 'co2', type: 'number', required: true },
        { label: '滴水频率', name: 'dripRate', type: 'number', required: true },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    }
  ],
  actions: [
    {
      id: 'site-normal',
      label: '常规观察',
      collection: 'sites',
      guards: [{ left: 'item.protectedStatus', op: 'neq', right: '封护', message: '封护中：须换人连续两晚复核达标后自动解除' }],
      patches: [{ field: 'protectedStatus', value: '常规观察' }]
    },
    {
      id: 'site-focus',
      label: '重点保护',
      collection: 'sites',
      guards: [{ left: 'item.protectedStatus', op: 'neq', right: '封护', message: '封护中：须换人连续两晚复核达标后自动解除' }],
      patches: [{ field: 'protectedStatus', value: '重点保护' }]
    },
    { id: 'site-close', label: '暂停开放', collection: 'sites', danger: true, patches: [{ field: 'protectedStatus', value: '暂停开放' }] },
    { id: 'site-rejudge', label: '重判封护', collection: 'sites', handler: 'rejudge' },
    {
      id: 'survey-alert',
      label: '标记异常',
      collection: 'surveys',
      relation: { collection: 'sites', localKey: 'siteId' },
      patches: [
        { field: 'status', value: '异常待复查' },
        { target: 'related', field: 'protectedStatus', value: '重点保护' }
      ]
    },
    { id: 'survey-review', label: '完成复查', collection: 'surveys', patches: [{ field: 'status', value: '已复查' }, { field: 'reviewNote', value: '异常已复核' }] }
  ]
};
