#!/bin/bash
yarn migration:run
yarn start:worker:prod &
yarn start:api:prod &
wait
