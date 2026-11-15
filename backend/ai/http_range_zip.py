"""Read selected public ZIP members without fetching the complete dataset."""
import io,urllib.request

class HTTPRangeZip(io.RawIOBase):
    def __init__(self,url,max_bytes=128*1024*1024):
        self.url=url;self.position=0;self.transferred=0;self.max_bytes=max_bytes
        with self._request(0,0) as response:
            self.size=int(response.headers['Content-Range'].split('/')[-1]);response.read()
    def _request(self,start,end):
        request=urllib.request.Request(self.url,headers={'Range':f'bytes={start}-{end}','User-Agent':'StudentAttention academic classroom evaluation','Accept-Encoding':'identity'})
        response=urllib.request.urlopen(request,timeout=45)
        if response.status!=206 or not response.headers.get('Content-Range','').startswith(f'bytes {start}-{end}/'):
            response.close();raise RuntimeError('Server did not honor HTTP Range; refusing full archive download')
        return response
    def seekable(self):return True
    def readable(self):return True
    def tell(self):return self.position
    def seek(self,offset,whence=0):
        position=offset if whence==0 else self.position+offset if whence==1 else self.size+offset
        if not 0<=position<=self.size:raise ValueError('Invalid archive offset')
        self.position=position;return position
    def read(self,size=-1):
        size=self.size-self.position if size<0 else min(size,self.size-self.position)
        if size==0:return b''
        if size<0 or self.transferred+size>self.max_bytes:raise RuntimeError('Archive inspection download budget exceeded')
        with self._request(self.position,self.position+size-1) as response:data=response.read(size+1)
        if len(data)!=size:raise RuntimeError('Incomplete HTTP range')
        self.position+=size;self.transferred+=size;return data
