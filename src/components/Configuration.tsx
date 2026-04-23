import React from 'react';
import { BarChart, PieChart, Wallet, Shield, Globe, Bell, ListTodo, Plus, Trash2, CheckCircle2, Activity, TrendingUp } from 'lucide-react';

export function PerformanceScreen() {
  const stats = [
    { label: 'Realized P&L', value: '+$4,240.50', trend: '+12.4%', color: 'text-emerald-400' },
    { label: 'Open P&L', value: '+$185.12', trend: '+1.2%', color: 'text-emerald-400' },
    { label: 'Win/Loss Ratio', value: '68%', trend: '42 Wins / 20 Loss', color: 'text-indigo-400' },
    { label: 'Broker Efficiency', value: '98.5%', trend: 'Avg. Slippage 0.2%', color: 'text-indigo-400' },
  ];

  const engineStats = [
    { name: 'Engine 1', wins: 24, loss: 8, rate: '75%', pnl: '+$1,240' },
    { name: 'Engine 2', wins: 18, loss: 12, rate: '60%', pnl: '+$840' },
    { name: 'Engine 3', wins: 12, loss: 15, rate: '44%', pnl: '-$120' },
    { name: 'Engine 4', wins: 32, loss: 10, rate: '76%', pnl: '+$2,150' },
    { name: 'Engine 5', wins: 8, loss: 2, rate: '80%', pnl: '+$540' },
  ];

  return (
    <div className="flex flex-col gap-6 pb-12">
      <div className="grid grid-cols-4 gap-4">
        {stats.map((stat) => (
          <div key={stat.label} className="glass p-4 rounded-xl">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">{stat.label}</p>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-[10px] text-slate-500 mt-1 uppercase font-bold tracking-tight">{stat.trend}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-6">
          <div className="glass p-6 rounded-xl min-h-[300px] flex flex-col">
            <div className="flex items-center justify-between mb-6">
               <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                  <BarChart size={14} className="text-indigo-400" />
                  Strategy Performance (Net Equity)
               </h3>
            </div>
            <div className="flex-1 flex items-end gap-2 px-2 pb-2">
              {[65, 45, 78, 52, 88, 92, 45, 67, 82, 55, 34, 66, 75, 80, 95].map((h, i) => (
                <div key={i} className="flex-1 bg-indigo-600/20 rounded-t hover:bg-indigo-500/40 transition-all cursor-pointer relative group border-x border-t border-indigo-500/20" style={{ height: `${h}%` }}>
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-2 px-2 text-[9px] font-bold text-slate-600 uppercase tracking-widest">
              <span>Mar 20</span>
              <span>May 20</span>
            </div>
          </div>

          <div className="glass p-6 rounded-xl">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-6">
               <Activity size={14} className="text-emerald-400" />
               Engine Win/Loss Analysis
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-white/5">
                  <tr>
                    <th className="py-2 px-4 italic">Engine ID</th>
                    <th className="py-2 px-4">Wins</th>
                    <th className="py-2 px-4">Losses</th>
                    <th className="py-2 px-4">Win Rate</th>
                    <th className="py-2 px-4 text-right">Net Contribution</th>
                  </tr>
                </thead>
                <tbody className="text-[11px] font-mono">
                  {engineStats.map((engine) => (
                    <tr key={engine.name} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="py-3 px-4 font-black text-indigo-400 uppercase tracking-tighter">{engine.name}</td>
                      <td className="py-3 px-4 text-emerald-400 font-bold">{engine.wins}</td>
                      <td className="py-3 px-4 text-rose-400 font-bold">{engine.loss}</td>
                      <td className="py-3 px-4 font-bold text-white">{engine.rate}</td>
                      <td className={`py-3 px-4 text-right font-black ${engine.pnl.startsWith('+') ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {engine.pnl}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="glass p-6 rounded-xl">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-6">
               <PieChart size={14} className="text-indigo-400" />
               Broker Distribution
            </h3>
            <div className="space-y-4">
              {[
                { name: 'Trading212', val: 12450.50, color: 'bg-indigo-500', perc: 45 },
                { name: 'Capital.com', val: 8240.20, color: 'bg-emerald-500', perc: 30 },
                { name: 'IG Markets', val: 4120.30, color: 'bg-amber-500', perc: 15 },
                { name: 'IBKR', val: 2740.00, color: 'bg-rose-500', perc: 10 },
              ].map((broker) => (
                <div key={broker.name} className="space-y-1">
                  <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest text-slate-500">
                    <span className="text-slate-300">{broker.name}</span>
                    <span className="text-white">${broker.val.toLocaleString()}</span>
                  </div>
                  <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                    <div className={`h-full ${broker.color}`} style={{ width: `${broker.perc}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="glass p-6 rounded-xl">
             <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
                <TrendingUp size={14} className="text-emerald-400" />
                Performance Density
             </h3>
             <div className="grid grid-cols-4 gap-1 h-32 items-end">
                {[20, 40, 30, 60, 80, 50, 40, 70, 90, 60, 50, 80].map((v, i) => (
                   <div key={i} className="bg-emerald-500/20 border-t-2 border-emerald-500/40 rounded-sm" style={{ height: `${v}%` }} />
                ))}
             </div>
             <p className="text-[10px] text-slate-500 mt-4 leading-relaxed font-medium">
                Analysis shows a 12% increase in engine efficiency during NYC market overlap (14:00 - 16:00 UTC).
             </p>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SettingsScreenProps {
  brokerConnected: boolean;
  brokerLoading: boolean;
  brokerError?: string;
  onConnectBroker: () => void;
  onDisconnectBroker: () => void;
}

export function SettingsScreen({ brokerConnected, brokerLoading, brokerError = '', onConnectBroker, onDisconnectBroker }: SettingsScreenProps) {
  const statusText = brokerLoading
    ? 'Loading'
    : brokerConnected
      ? 'Connected (Demo)'
      : brokerError
        ? 'Disconnected'
        : 'Disconnected';

  return (
    <div className="grid grid-cols-3 gap-6">
      <div className="col-span-2 space-y-6">
        <section className="glass p-6 rounded-xl">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-6">
            <Wallet size={14} className="text-indigo-400" />
            Broker Connections
          </h3>
          <div className="space-y-3">
             <div className="p-4 bg-white/5 border border-white/10 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-4">
                   <div className="w-10 h-10 bg-indigo-600/20 border border-indigo-500/20 rounded-lg flex items-center justify-center font-black text-indigo-400">T2</div>
                   <div>
                      <p className="text-xs font-bold text-white tracking-widest">Trading212</p>
                      <p className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 ${brokerConnected ? 'text-emerald-400 status-pulse' : brokerLoading ? 'text-amber-400' : 'text-slate-500'}`}>
                         {statusText}
                      </p>
                      {brokerError && !brokerConnected && <p className="mt-1 text-[10px] text-rose-400 max-w-xl">{brokerError}</p>}
                   </div>
                </div>
                {brokerConnected || brokerLoading ? (
                  <button
                    onClick={onDisconnectBroker}
                    className="text-[10px] font-bold text-rose-400 uppercase tracking-widest hover:underline"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    onClick={onConnectBroker}
                    className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest hover:underline"
                  >
                    Connect
                  </button>
                )}
             </div>
             
             <div className="p-8 border border-white/5 border-dashed rounded-xl flex items-center justify-center gap-3 text-slate-500 hover:text-slate-300 hover:bg-white/5 cursor-pointer transition-all">
               <Plus size={16} />
               <span className="text-xs font-bold uppercase tracking-widest">Connect New Broker</span>
             </div>
          </div>
        </section>

        <section className="glass p-6 rounded-xl">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-6">
            <Shield size={14} className="text-emerald-400" />
             Execution Rules
          </h3>
          <div className="grid grid-cols-2 gap-6">
             <div className="space-y-4">
                <div className="space-y-2">
                   <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Risk per Trade (%)</label>
                   <input type="number" defaultValue="1.0" className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-xs text-white" />
                </div>
             </div>
             <div className="space-y-4">
                <div className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/10">
                   <div>
                      <p className="text-[10px] font-bold text-slate-200 uppercase tracking-widest">Auto-execute</p>
                   </div>
                   <div className="w-10 h-5 bg-indigo-600 rounded-full relative p-1">
                      <div className="absolute right-1 w-3 h-3 bg-white rounded-full" />
                   </div>
                </div>
             </div>
          </div>
        </section>
      </div>

      <div className="space-y-6">
         <section className="glass p-6 rounded-xl">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
               <Bell size={14} className="text-amber-400" />
               Alerts
            </h3>
            <div className="space-y-3">
               <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-indigo-500/10 border border-indigo-500/20 rounded-lg flex items-center justify-center text-indigo-400"><Globe size={14} /></div>
                  <div className="flex-1">
                     <p className="text-[10px] font-bold text-white tracking-widest uppercase">Telegram</p>
                  </div>
                  <button className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">On</button>
               </div>
            </div>
         </section>
      </div>
    </div>
  );
}
