import React from 'react';
import { AlertTriangle, TrendingDown, TrendingUp, X } from 'lucide-react';
import { Order, Position } from '../types';

export function OrdersTable({ orders }: { orders: Order[] }) {
  return (
    <div className="glass rounded-xl overflow-hidden flex flex-col flex-1">
      <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">Trading212 Open Orders / App Orders</h2>
        <div className="flex gap-2 text-[10px] font-bold uppercase tracking-widest">
           <button className="px-3 py-1 bg-indigo-600 text-white rounded">All</button>
           <button className="px-3 py-1 bg-white/5 text-slate-500 rounded border border-white/10 hover:text-slate-300">Open</button>
        </div>
      </div>
      <div className="overflow-auto flex-1">
        <table className="w-full text-left border-collapse">
          <thead className="text-[10px] uppercase text-slate-500 font-bold tracking-tight bg-slate-900/50">
            <tr>
              <th className="py-2 px-3">Date Time</th>
              <th className="py-2 px-3">Symbol</th>
              <th className="py-2 px-3">Side</th>
              <th className="py-2 px-3 text-right">Entry</th>
              <th className="py-2 px-3 text-right">SL</th>
              <th className="py-2 px-3">Status</th>
              <th className="py-2 px-3 text-right">P&L</th>
              <th className="py-2 px-3">Broker ID</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {orders.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 px-3 text-center text-slate-500 font-sans text-xs">No open Trading212 orders returned.</td>
              </tr>
            )}
            {orders.map((order) => (
              <tr key={order.id} className="hover:bg-white/5 transition-colors border-b border-white/5">
                <td className="py-2 px-3 text-slate-400">{order.buyDateTime}</td>
                <td className="py-2 px-3 font-bold text-white uppercase">{order.symbol}</td>
                <td className="py-2 px-3">
                  <span className={`font-bold ${order.side === 'Buy' ? 'text-emerald-400' : 'text-rose-400'}`}>{order.side}</span>
                </td>
                <td className="py-2 px-3 text-right text-slate-200">${order.entry.toFixed(2)}</td>
                <td className="py-2 px-3 text-right text-rose-400">${order.sl.toFixed(2)}</td>
                <td className="py-2 px-3">
                   <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold ${order.status === 'Open' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'bg-white/5 text-slate-500'}`}>
                    {order.status}
                  </span>
                </td>
                <td className={`py-2 px-3 text-right font-bold ${order.pnl && order.pnl > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {order.pnl ? `${order.pnl > 0 ? '+' : ''}$${order.pnl.toFixed(2)}` : '--'}
                </td>
                <td className="py-2 px-3 text-[10px] text-slate-500">{order.brokerOrderId || order.type || '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function baseSymbol(symbol: string) {
  return symbol.toUpperCase().split('_')[0];
}

function orderMatchesPosition(order: Order, position: Position) {
  return order.symbol.toUpperCase() === position.symbol.toUpperCase() || baseSymbol(order.symbol) === baseSymbol(position.symbol);
}

function priceWithStatus(value?: number, status?: string, tone: 'target' | 'stop' = 'target', note?: string) {
  const title = note || (status ? `${status} broker order` : 'Active broker order');
  if (!value) {
    return (
      <span className="text-slate-500 cursor-help" title={note || `No ${tone === 'target' ? 'target limit' : 'stop-loss'} order found for this position`}>
        --
      </span>
    );
  }
  const active = !status || ['NEW', 'PLACED', 'OPEN'].includes(status.toUpperCase());
  const color = active
    ? tone === 'target' ? 'text-emerald-300' : 'text-rose-300'
    : 'text-amber-300';
  return (
    <span className={`${color} cursor-help`} title={title}>
      ${value.toFixed(2)}
      {status && !active && <span className="ml-1 text-[9px] text-amber-400">({status})</span>}
    </span>
  );
}

function triggerEngineCell(position: Position) {
  const engines = position.triggerEngines || [];
  if (!engines.length) {
    return (
      <span
        className="text-slate-600 cursor-help"
        title="No app-order trigger metadata or current live scanner engine match is available for this broker position."
      >
        --
      </span>
    );
  }

  return (
    <div
      className="flex flex-col gap-1"
      title={[position.triggerSource, position.triggerGroup ? `Group: ${position.triggerGroup}` : '', position.triggerNote].filter(Boolean).join(' | ')}
    >
      <div className="flex gap-1">
        {engines.map((engine) => (
          <span key={engine} className="text-[9px] font-black px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20">
            {engine}
          </span>
        ))}
      </div>
      <span className="text-[9px] text-slate-500 font-sans">{position.triggerSource || 'Trigger source'}</span>
    </div>
  );
}

interface PositionsTableProps {
  positions: Position[];
  orders?: Order[];
  closingBusy?: boolean;
  closeMessage?: string;
  onClosePositions?: (positions: Position[]) => void;
}

export function PositionsTable({ positions, orders = [], closingBusy = false, closeMessage = '', onClosePositions }: PositionsTableProps) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const selectedPositions = positions.filter((position) => selected.has(position.id));
  const selectedValue = selectedPositions.reduce((total, position) => total + Math.abs(position.marketValue ?? position.size * position.currentPrice), 0);
  const selectedPnl = selectedPositions.reduce((total, position) => total + position.pnl, 0);
  const relatedOrders = selectedPositions.flatMap((position) => orders.filter((order) => orderMatchesPosition(order, position)));
  const allSelected = positions.length > 0 && selected.size === positions.length;

  const togglePosition = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(positions.map((position) => position.id)));
  };

  const submitClose = () => {
    onClosePositions?.(selectedPositions);
    setConfirmOpen(false);
  };

  return (
    <div className="glass rounded-xl overflow-hidden flex flex-col flex-1">
      <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">Broker Positions</h2>
          {closeMessage && <p className="mt-1 text-[10px] text-slate-400">{closeMessage}</p>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">Connected</span>
          <button
            disabled={!selectedPositions.length || closingBusy}
            onClick={() => setConfirmOpen(true)}
            className={`px-3 py-1.5 rounded-lg border text-[10px] font-black uppercase tracking-widest transition-all ${
              selectedPositions.length && !closingBusy
                ? 'bg-rose-600/20 text-rose-300 border-rose-500/30 hover:bg-rose-600/30'
                : 'bg-white/5 text-slate-600 border-white/10 cursor-not-allowed'
            }`}
          >
            Close Selected ({selectedPositions.length})
          </button>
        </div>
      </div>
      <div className="overflow-auto flex-1">
        <table className="w-full text-left border-collapse">
          <thead className="text-[10px] uppercase text-slate-500 font-bold tracking-tight bg-slate-900/50">
            <tr>
              <th className="py-2 px-3 w-10">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-rose-500" />
              </th>
              <th className="py-2 px-3">Purchase Date Time</th>
              <th className="py-2 px-3">Broker</th>
              <th className="py-2 px-3">Symbol</th>
              <th className="py-2 px-3">Trigger Engine</th>
              <th className="py-2 px-3 text-right">Size</th>
              <th className="py-2 px-3 text-right">Entry Price</th>
              <th className="py-2 px-3 text-right">Total Invested</th>
              <th className="py-2 px-3 text-right">Current Market Price</th>
              <th className="py-2 px-3 text-right">Current Market Value</th>
              <th className="py-2 px-3 text-right">Target</th>
              <th className="py-2 px-3 text-right">Stop Loss</th>
              <th className="py-2 px-3 text-right">Unrealized P&L</th>
              <th className="py-2 px-3 text-right">% Change</th>
              <th className="py-2 px-3">Action</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {positions.length === 0 && (
              <tr>
                <td colSpan={15} className="py-8 px-3 text-center text-slate-500 font-sans text-xs">No open Trading212 demo positions returned.</td>
              </tr>
            )}
            {positions.map((pos) => (
              <tr key={pos.id} className="hover:bg-white/5 transition-colors border-b border-white/5">
                <td className="py-2 px-3">
                  <input type="checkbox" checked={selected.has(pos.id)} onChange={() => togglePosition(pos.id)} className="accent-rose-500" />
                </td>
                <td className="py-2 px-3 text-slate-400 whitespace-nowrap">{pos.purchaseDateTime || '--'}</td>
                <td className="py-2 px-3 font-bold text-indigo-400 uppercase tracking-tight">{pos.broker}</td>
                <td className="py-2 px-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-bold text-white uppercase">{pos.symbol}</span>
                    <span className="text-[10px] text-slate-500 font-sans">{pos.company || baseSymbol(pos.symbol)}</span>
                  </div>
                </td>
                <td className="py-2 px-3 min-w-[130px]">{triggerEngineCell(pos)}</td>
                <td className="py-2 px-3 text-right text-slate-300">{pos.size}</td>
                <td className="py-2 px-3 text-right text-slate-300">${pos.avgPrice.toFixed(2)}</td>
                <td className="py-2 px-3 text-right text-slate-200">${Math.abs(pos.avgPrice * pos.size).toFixed(2)}</td>
                <td className="py-2 px-3 text-right text-white">${pos.currentPrice.toFixed(2)}</td>
                <td className="py-2 px-3 text-right text-slate-200">${Math.abs(pos.marketValue ?? pos.size * pos.currentPrice).toFixed(2)}</td>
                <td className="py-2 px-3 text-right">{priceWithStatus(pos.target, pos.targetStatus, 'target', pos.targetNote)}</td>
                <td className="py-2 px-3 text-right">{priceWithStatus(pos.stopLoss, pos.stopLossStatus, 'stop', pos.stopLossNote)}</td>
                <td className={`py-2 px-3 text-right font-bold ${pos.pnl > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  <div className="flex items-center justify-end gap-1">
                    {pos.pnl > 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                    {pos.pnl > 0 ? '+' : ''}${pos.pnl.toFixed(2)}
                  </div>
                </td>
                <td className={`py-2 px-3 text-right font-bold ${pos.pnlPercent > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {pos.pnlPercent > 0 ? '+' : ''}{pos.pnlPercent.toFixed(2)}%
                </td>
                <td className="py-2 px-3">
                   <button onClick={() => { setSelected(new Set([pos.id])); setConfirmOpen(true); }} className="text-rose-400 underline text-[10px] font-bold uppercase">Close</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirmOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-3xl glass rounded-xl border border-rose-500/20 shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-white/10 flex items-center justify-between bg-rose-500/5">
              <div className="flex items-center gap-3">
                <AlertTriangle size={18} className="text-rose-400" />
                <div>
                  <h3 className="text-sm font-black text-white uppercase tracking-wider">Confirm Demo Market Close</h3>
                  <p className="text-[11px] text-slate-400">Existing open orders for these symbols will be cancelled before closing.</p>
                </div>
              </div>
              <button onClick={() => setConfirmOpen(false)} className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-slate-400">
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                  <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Positions</p>
                  <p className="text-lg font-black text-white">{selectedPositions.length}</p>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                  <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Est. Value</p>
                  <p className="text-lg font-black text-white">${selectedValue.toFixed(2)}</p>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                  <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Current P&L</p>
                  <p className={`text-lg font-black ${selectedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{selectedPnl >= 0 ? '+' : ''}${selectedPnl.toFixed(2)}</p>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                  <p className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">Open Orders</p>
                  <p className="text-lg font-black text-amber-300">{relatedOrders.length}</p>
                </div>
              </div>
              <div className="max-h-64 overflow-auto border border-white/10 rounded-lg">
                <table className="w-full text-left text-[11px] font-mono">
                  <thead className="bg-slate-900/70 text-slate-500 uppercase">
                    <tr>
                      <th className="py-2 px-3">Symbol</th>
                      <th className="py-2 px-3">Engine</th>
                      <th className="py-2 px-3 text-right">Qty</th>
                      <th className="py-2 px-3 text-right">Entry</th>
                      <th className="py-2 px-3 text-right">Invested</th>
                      <th className="py-2 px-3 text-right">Current</th>
                      <th className="py-2 px-3 text-right">Target</th>
                      <th className="py-2 px-3 text-right">Stop</th>
                      <th className="py-2 px-3 text-right">Est. Value</th>
                      <th className="py-2 px-3 text-right">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPositions.map((position) => (
                      <tr key={position.id} className="border-t border-white/5">
                        <td className="py-2 px-3 font-bold text-white">{position.symbol}</td>
                        <td className="py-2 px-3">{triggerEngineCell(position)}</td>
                        <td className="py-2 px-3 text-right">{position.size}</td>
                        <td className="py-2 px-3 text-right">${position.avgPrice.toFixed(2)}</td>
                        <td className="py-2 px-3 text-right">${Math.abs(position.avgPrice * position.size).toFixed(2)}</td>
                        <td className="py-2 px-3 text-right">${position.currentPrice.toFixed(2)}</td>
                        <td className="py-2 px-3 text-right">{priceWithStatus(position.target, position.targetStatus, 'target', position.targetNote)}</td>
                        <td className="py-2 px-3 text-right">{priceWithStatus(position.stopLoss, position.stopLossStatus, 'stop', position.stopLossNote)}</td>
                        <td className="py-2 px-3 text-right">${Math.abs(position.marketValue ?? position.size * position.currentPrice).toFixed(2)}</td>
                        <td className={`py-2 px-3 text-right font-bold ${position.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{position.pnl >= 0 ? '+' : ''}${position.pnl.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-amber-100 leading-relaxed">
                This sends market sell orders for the full selected quantities in the Trading212 demo account. Market price can change between this screen and execution.
              </div>
            </div>
            <div className="p-4 border-t border-white/10 flex justify-end gap-3">
              <button onClick={() => setConfirmOpen(false)} className="btn-secondary">Cancel</button>
              <button disabled={closingBusy} onClick={submitClose} className="bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-bold text-xs transition-all">
                {closingBusy ? 'Closing...' : 'Cancel Orders & Close Demo Positions'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
