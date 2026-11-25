import { agentDescriptor } from '../agent/registry';
import type { agentFailoverView, AgentSwitchPhase, AgentSwitchRequest } from '../runtime/agent-failover';

type AgentState = ReturnType<typeof agentFailoverView>;

export interface AgentSwitchResult {
  title: string;
  ok: boolean;
  detail?: string;
}

function text(content: string) {
  return { tag: 'plain_text', content };
}

function button(label: string, cmd: string, arg?: string) {
  return { tag: 'button', text: text(label), behaviors: [{ type: 'callback', value: { cmd, arg } }] };
}

function card(title: string, template: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: title } },
    header: { title: text(title), template },
    body: { direction: 'vertical', padding: '12px 12px 16px 12px', vertical_spacing: '8px', elements },
  };
}

export function agentSwitchPanel(state: AgentState, result?: AgentSwitchResult): object {
  const current = agentDescriptor(state.current);
  const standby = state.standby ? agentDescriptor(state.standby) : undefined;
  const agents = state.agents.filter(({ kind }) => kind !== state.current && kind !== state.standby);
  const pair = `${state.current} ${state.standby}`;
  const access = current.ownerDmOnly ? '（仅主人私聊）' : '';
  return card(result?.title ?? 'Agent 切换', result ? (result.ok ? 'green' : 'red') : 'blue', [
    ...(result?.detail ? [{ tag: 'div', text: text(result.detail) }] : []),
    {
      tag: 'markdown',
      content: `**${result && !result.ok ? '当前配置' : '当前运行'}** ${current.displayName}${access}\n**备用** ${standby?.displayName ?? '未设置'}` +
        (standby?.ownerDmOnly ? '\n切入后仅主人私聊可用，群聊、定时任务和评论暂停。' : ''),
    },
    ...(standby ? [
      { ...button(`切换到 ${standby.displayName}`, 'agent.switch', pair), type: 'primary' },
      { tag: 'markdown', content: '检查通过后，最多等待进行中的任务 60 秒。切回可接续原会话。', text_size: 'notation' },
      {
        ...button('中断任务并切换', 'agent.interrupt', pair),
        type: 'danger',
        confirm: {
          title: text(`中断任务并切换到 ${standby.displayName}？`),
          text: text('检查通过后会停止正在运行的任务。被中断的任务需手动重跑。'),
        },
      },
    ] : []),
    {
      tag: 'collapsible_panel',
      expanded: !standby,
      header: {
        title: { tag: 'markdown', content: standby ? '更改备用 agent' : '选择备用 agent' },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      vertical_spacing: '8px',
      elements: [
        ...agents.map((agent) =>
          button(`${agent.name}${agent.ownerDmOnly ? '（仅主人私聊）' : ''}`, 'agent.standby', agent.kind),
        ),
        ...(standby ? [button('取消备用', 'agent.standby', 'none')] : []),
      ],
    },
  ]);
}

const phaseLabels = {
  checking: '检查备用 agent 是否可用',
  waiting: '等待进行中的任务结束（最多 60 秒）',
  interrupting: '中断进行中的任务',
  connecting: '连接飞书并启用目标 agent',
} satisfies Record<AgentSwitchPhase, string>;

export function agentSwitchProgress(request: AgentSwitchRequest, phase: AgentSwitchPhase): object {
  return card(phaseLabels[phase], 'blue', [{
    tag: 'markdown',
    content: `${agentDescriptor(request.expected).displayName} → **${agentDescriptor(request.target).displayName}**`,
  }]);
}
