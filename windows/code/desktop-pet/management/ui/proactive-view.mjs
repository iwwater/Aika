import {el,button,badge,notice,card,field,select} from './dom.mjs';

const hours=Array.from({length:24},(_,hour)=>({value:String(hour),label:String(hour).padStart(2,'0')+':00'}));

/** Opt-in controls for durable continuity-sourced invitations; the view never reads fact text. */
export function createProactiveView(client,render,getContext){
  let policy=null,draft=null,error='',message='',loading=false,sequence=0;
  const pairing=()=>getContext().pairing;
  async function refresh(){
    if(getContext().connection!=='online'){sequence++;policy=null;draft=null;loading=false;error='';message='';render();return;}
    const current=++sequence;loading=true;error='';render();
    try{
      const result=await client.request('/api/proactive/policy',{method:'POST',body:{pairing:pairing()}});
      if(current!==sequence)return;
      policy=result.policy;draft={...policy};message='';
    }catch(cause){if(current===sequence)error=cause.message||'读取主动陪伴设置失败。';}
    finally{if(current===sequence){loading=false;render();}}
  }
  function edit(key,value){if(!draft)return;draft={...draft,[key]:value};message='';render();}
  async function save(){
    const context=getContext();if(!policy||!draft||context.connection!=='online'||loading)return;
    loading=true;error='';message='';render();
    try{
      const result=await client.request('/api/proactive/policy',{method:'PUT',body:{pairing:pairing(),expectedRevision:policy.revision,
        policy:{enabled:draft.enabled,dailyMax:Number(draft.dailyMax),minIntervalMs:Number(draft.minIntervalMs),timezone:draft.timezone,
          dndStartHour:Number(draft.dndStartHour),dndEndHour:Number(draft.dndEndHour),sourceKinds:['continuity_fact']}}});
      policy=result.policy;draft={...policy};message=policy.enabled?'策略已启用。开启后新确认的有效事实可生成待仲裁邀请。':'策略已关闭；未展示候选已清理。';
    }catch(cause){error=cause.message||'保存主动陪伴设置失败。';}
    finally{loading=false;render();}
  }
  function view(){
    const context=getContext();
    if(context.connection!=='online')return card('主动陪伴',notice('连接运行中的桌宠后才能读取或修改策略。','warning'),button('重新读取',refresh,{disabled:true}));
    if(loading&&!policy)return card('主动陪伴',notice('正在读取当前策略…'));
    if(!policy||!draft)return card('主动陪伴',error&&notice(error,'error'),button('读取策略',refresh,{class:'primary',disabled:loading}));
    const clean=JSON.stringify(policy)===JSON.stringify({...draft,revision:policy.revision});
    return el('div',{class:'page-content'},
      card('主动陪伴',
        el('p',{class:'subtle'},'默认关闭。开启后，只会从此刻之后新晋升且来源有效的事实或里程碑生成邀请；未经确认的候选不会触发，邀请正文不包含事实原文。接受会进入普通文字轮次，不会开启麦克风或工作工具。'),
        error&&notice(error,'error'),message&&notice(message,'success'),
        el('label',{class:'field toggle-field'},el('span',{},'允许桌宠主动发起文字邀请'),el('input',{type:'checkbox',checked:draft.enabled,disabled:loading,onChange:event=>edit('enabled',event.target.checked)})),
        el('div',{class:'form-grid'},
          field('每天最多展示次数','proactive-daily-max',draft.dailyMax,value=>edit('dailyMax',Number(value)),{type:'number',min:0,max:2,step:1,disabled:loading||!draft.enabled,hint:'与本地问候共享现有上限，不能高于每天 2 次。'}),
          field('最小展示间隔（小时）','proactive-interval',Math.round(draft.minIntervalMs/3_600_000),value=>edit('minIntervalMs',Number(value)*3_600_000),{type:'number',min:3,max:168,step:1,disabled:loading||!draft.enabled,hint:'至少 3 小时，并与既有邀请共用冷却。'}),
          select('免打扰开始','proactive-dnd-start',draft.dndStartHour,hours,value=>edit('dndStartHour',Number(value)),{disabled:loading||!draft.enabled}),
          select('免打扰结束','proactive-dnd-end',draft.dndEndHour,hours,value=>edit('dndEndHour',Number(value)),{disabled:loading||!draft.enabled})),
        el('div',{class:'label-row section-gap'},badge('来源：已确认 continuity fact / milestone', 'muted'),badge('时区：'+draft.timezone,'muted')),
        notice('屏幕 Observation 与日程来源尚未接入，因此不能在这里选择；旧条目不会在首次启用时回溯生成邀请。','muted'),
        el('div',{class:'actions'},button('恢复已保存设置',()=>{draft={...policy};message='';error='';render();},{disabled:loading||clean}),button(loading?'正在保存…':'保存策略',save,{class:'primary',disabled:loading||clean}))),
      card('仲裁与隐私',
        el('ul',{},el('li',{},'忙于输入、语音、对话或待确认工作卡时不展示。桌面忙闲状态超过 3 秒未更新时按忙碌处理。'),
          el('li',{},'免打扰、配额、冷却和来源版本由后端持久仲裁；来源编辑、失效或遗忘会撤销关联候选。'),
          el('li',{},'候选和审计仅保存邀请文案、来源 ID/版本与状态，不复制连续性事实正文。'))));
  }
  return {view,refresh,dispose(){sequence++;}};
}
