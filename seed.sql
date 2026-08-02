-- Demo data for LOCAL dev only (`npm run dev` applies it; never run against --remote).
-- Fixed ids + INSERT OR REPLACE so re-running on every dev start is idempotent: seeded
-- rows snap back to this state, anything you added by hand survives.
-- Dates are computed from `now` shifted -5h (Bogota wall clock, no DST) so the digest,
-- the "vence hoy" badges and the visit reminders always look alive.

INSERT OR REPLACE INTO items (id,category,title,notes,due_date,recurrence,recur_day,amount,status,created_by,created_at,updated_at) VALUES
  (1,'bills','Administración',NULL,date('now','-5 hours'),'monthly',1,'$ 420.000','open','Felipe',strftime('%Y-%m-%dT%H:%M','now','-5 hours'),strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (2,'bills','Internet Claro',NULL,date('now','-5 hours','+3 days'),'monthly',4,'$ 119.900','open','Lucía',strftime('%Y-%m-%dT%H:%M','now','-5 hours'),strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (3,'bills','Gas natural',NULL,date('now','-5 hours','-2 days'),'none',NULL,'$ 38.500','open','Felipe',strftime('%Y-%m-%dT%H:%M','now','-5 hours'),strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (4,'groceries','Café','de la tienda de la 63',NULL,'none',NULL,NULL,'open','Lucía',strftime('%Y-%m-%dT%H:%M','now','-5 hours'),strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (5,'groceries','Pañales talla 3',NULL,NULL,'none',NULL,NULL,'open','Felipe',strftime('%Y-%m-%dT%H:%M','now','-5 hours'),strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (6,'events','Cumpleaños de Mariana','llevar torta',date('now','-5 hours','+9 days'),'none',NULL,NULL,'open','Lucía',strftime('%Y-%m-%dT%H:%M','now','-5 hours'),strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (7,'health','Cita odontología',NULL,date('now','-5 hours','+1 day'),'none',NULL,NULL,'open','Felipe',strftime('%Y-%m-%dT%H:%M','now','-5 hours'),strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (8,'pediatrician','¿Cuándo toca el refuerzo de la vacuna?',NULL,NULL,'none',NULL,NULL,'open','Lucía',strftime('%Y-%m-%dT%H:%M','now','-5 hours'),strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (9,'general','Renovar SOAT del carro',NULL,date('now','-5 hours','+21 days'),'none',NULL,'$ 560.000','open','Felipe',strftime('%Y-%m-%dT%H:%M','now','-5 hours'),strftime('%Y-%m-%dT%H:%M','now','-5 hours'));

INSERT OR REPLACE INTO apartments (id,url,deal_type,title,price,admin_fee,bedrooms,bathrooms,area_m2,price_per_m2,parking,stratum,location,year_built,amenities,source_site,raw_note,scrape_status,image_url,notes,address,agent_name,agent_phone,tag,status,created_by,created_at,updated_at,visit_date,ruled_out_reason,ruled_out_at,geo_lat,geo_lng,geo_address) VALUES
  (1,'https://example.com/listing/1','rent','Apartamento en arriendo en Chapinero Alto',4200000,480000,3,2,92,NULL,1,4,'Chapinero Alto',2016,'Gimnasio, terraza comunal, portería 24h','example.com',NULL,'ok',NULL,
   'Felipe: la cocina es más chica de lo que se ve en las fotos.','Carrera 5 # 63-20, Bogotá','Ana Restrepo','+57 310 555 1122','favorito','active','Felipe',
   strftime('%Y-%m-%dT%H:%M','now','-5 hours','-6 days'),strftime('%Y-%m-%dT%H:%M','now','-5 hours'),
   strftime('%Y-%m-%d','now','-5 hours','+1 day')||'T10:30',NULL,NULL,4.6486,-74.0629,'Carrera 5 # 63-20, Bogotá'),
  (2,'https://example.com/listing/2','rent','Apartamento en arriendo en Cedritos',3100000,320000,2,2,68,NULL,1,4,'Cedritos',2009,'Ascensor, zona BBQ','example.com',NULL,'ok',NULL,
   NULL,'Calle 140 # 11-45, Bogotá','Jorge Peña','+57 320 555 8844',NULL,'active','Lucía',
   strftime('%Y-%m-%dT%H:%M','now','-5 hours','-4 days'),strftime('%Y-%m-%dT%H:%M','now','-5 hours'),
   NULL,NULL,NULL,4.7280,-74.0330,'Calle 140 # 11-45, Bogotá'),
  (3,'https://example.com/listing/3','buy','Apartamento en venta en Teusaquillo',520000000,NULL,3,2,105,4952381,1,4,'Teusaquillo',1994,'Balcón, depósito','example.com',NULL,'ok',NULL,
   'Lucía: buena luz por la mañana, pero el edificio es viejo.','Calle 39 # 20-15, Bogotá','Inmobiliaria Sur','+57 601 555 7700',NULL,'active','Felipe',
   strftime('%Y-%m-%dT%H:%M','now','-5 hours','-9 days'),strftime('%Y-%m-%dT%H:%M','now','-5 hours'),
   strftime('%Y-%m-%d','now','-5 hours','-3 days')||'T16:00',NULL,NULL,4.6320,-74.0790,'Calle 39 # 20-15, Bogotá'),
  (4,'https://example.com/listing/4','rent','Apartaestudio en Usaquén',2400000,250000,1,1,44,NULL,0,5,'Usaquén',2020,'Coworking, rooftop','example.com',NULL,'blocked',NULL,
   NULL,NULL,NULL,NULL,NULL,'ruled_out','Lucía',
   strftime('%Y-%m-%dT%H:%M','now','-5 hours','-12 days'),strftime('%Y-%m-%dT%H:%M','now','-5 hours','-7 days'),
   NULL,'muy pequeño para los tres',strftime('%Y-%m-%dT%H:%M','now','-5 hours','-7 days'),NULL,NULL,NULL),
  (5,NULL,'rent',NULL,2900000,200000,2,1,60,NULL,0,3,'Suba, cerca al parque',NULL,NULL,NULL,'aviso en la portería, sin link','manual',NULL,
   NULL,NULL,NULL,NULL,NULL,'active','Felipe',
   strftime('%Y-%m-%dT%H:%M','now','-5 hours','-1 day'),strftime('%Y-%m-%dT%H:%M','now','-5 hours','-1 day'),
   NULL,NULL,NULL,NULL,NULL,NULL);

INSERT OR REPLACE INTO apartment_votes (apartment_id,voter,vote,updated_at) VALUES
  (1,'felipe','up',strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (1,'lucia','up',strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (3,'felipe','up',strftime('%Y-%m-%dT%H:%M','now','-5 hours')),
  (3,'lucia','down',strftime('%Y-%m-%dT%H:%M','now','-5 hours'));
