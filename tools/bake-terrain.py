#!/usr/bin/env python3
"""Bake only the city's window from ACT's CC0 2024 bare-earth LiDAR COG.

HTTP ranges and overviews avoid downloading the 37 GB national raster.
The local grid uses the same equirectangular projection as city.json.
"""
import os
import json
import math
import certifi
os.environ.update(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_HTTP_CONNECTTIMEOUT='15', GDAL_HTTP_TIMEOUT='60', CURL_CA_BUNDLE=certifi.where())
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
from pyproj import Transformer
url='https://download.data.public.lu/resources/bd-l-lidar2024-releve-3d-du-territoire-luxembourgeois/20241223-093912/MNT_Lidar2024.tif'
city=json.load(open('public/data/city.json', encoding='utf-8'))
lat0,lon0=city['meta']['origin']; radius=6378137; radians=math.pi/180
xs=np.arange(-1504,2720+1,8,dtype=float); ys=np.arange(-1920,2112+1,8,dtype=float)
mx,my=np.meshgrid(xs,ys)
lons=lon0+mx/(radius*math.cos(lat0*radians)*radians); lats=lat0+my/(radius*radians)
print('Opening official ACT 2024 terrain COG with HTTP range reads',flush=True)
with rasterio.open(url) as src:
 print('Raster',src.crs,src.res,src.width,src.height,'overviews',src.overviews(1),flush=True)
 transform=Transformer.from_crs('EPSG:4326',src.crs,always_xy=True)
 x,y=transform.transform(lons,lats)
 window=from_bounds(x.min()-16,y.min()-16,x.max()+16,y.max()+16,src.transform).round_offsets().round_lengths()
 width=math.ceil(window.width*abs(src.res[0])/4); height=math.ceil(window.height*abs(src.res[1])/4)
 print('Reading city window at 4m:',width,height,flush=True)
 data=src.read(1,window=window,out_shape=(height,width),resampling=Resampling.average,masked=True)
 affine=src.window_transform(window)*src.transform.scale(window.width/width,window.height/height)
 col=(x-affine.c)/affine.a-.5; row=(y-affine.f)/affine.e-.5
 ix=np.floor(col).astype(int); iy=np.floor(row).astype(int); fx=col-ix; fy=row-iy
 z=(data[iy,ix]*(1-fx)+data[iy,ix+1]*fx)*(1-fy)+(data[iy+1,ix]*(1-fx)+data[iy+1,ix+1]*fx)*fy
 if np.ma.getmaskarray(z).any() or not np.isfinite(z).all(): raise RuntimeError('Missing or invalid terrain samples')
 base=round(float(z[np.argmin(abs(ys)),np.argmin(abs(xs))]),2)
 result={'nx':len(xs),'ny':len(ys),'minX':float(xs[0]),'maxX':float(xs[-1]),'minY':float(ys[0]),'maxY':float(ys[-1]),'base':base,'spacing':8,'source':{'name':'ACT BD-L-Lidar2024 MNT','url':url,'page':'https://data.public.lu/fr/datasets/lidar-2024-releve-3d-du-territoire-luxembourgeois/','license':'CC0','nativeResolutionMetres':.5},'heights':np.round(z-base,2).ravel().tolist()}
 json.dump(result,open('public/data/heightfield.json','w',encoding='utf-8'),separators=(',',':'))
 print('Baked',result['nx'],result['ny'],'base',base,'relief',float(z.min()-base),float(z.max()-base),'bytes',os.path.getsize('public/data/heightfield.json'),flush=True)
