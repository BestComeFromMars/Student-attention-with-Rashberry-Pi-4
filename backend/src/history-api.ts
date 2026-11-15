import {Router,json} from 'express';
import {HttpError} from './errors.js';
import type {HistoryStore} from './history-store.js';

export function historyApi(store?:HistoryStore){
  const router=Router();
  router.use((request,_response,next)=>{
    const address=request.socket.remoteAddress,origin=request.get('Origin');
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address??'')||
      origin&&!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))throw new HttpError(403,'Lịch sử chỉ được truy cập từ ứng dụng trên máy này.');
    if(!store)throw new HttpError(503,'Chưa cấu hình thư mục lịch sử.');
    next();
  });
  router.get('/days',async(_req,res)=>{res.json({days:await store!.listDays()});});
  router.get('/days/:date',async(req,res)=>{res.json({runs:await store!.listRuns(String(req.params.date))});});
  router.delete('/days/:date',async(req,res)=>{await store!.removeDay(String(req.params.date));res.status(204).end();});
  router.post('/runs',json({limit:'4kb'}),async(req,res)=>{res.status(201).json(await store!.create(req.body));});
  router.get('/runs/:id',async(req,res)=>{res.json(await store!.get(String(req.params.id)));});
  router.patch('/runs/:id',json({limit:'2kb'}),async(req,res)=>{res.json(await store!.end(String(req.params.id),req.body));});
  router.delete('/runs/:id',async(req,res)=>{await store!.removeRun(String(req.params.id));res.status(204).end();});
  router.put('/runs/:id/captures',json({limit:'2mb'}),async(req,res)=>{res.json(await store!.update(String(req.params.id),req.body));});
  router.get('/runs/:id/captures/:captureId/photo',async(req,res)=>{
    res.type('image/jpeg').send(await store!.photo(String(req.params.id),String(req.params.captureId)));
  });
  return router;
}
