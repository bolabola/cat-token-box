FROM node:20

ENV TIME_ZONE=Asia/Shanghai
ENV TZ=Asia/Shanghai

WORKDIR /app
COPY . /app/
RUN yarn install && yarn build 

WORKDIR /app/packages/tracker
RUN yarn install && yarn build

EXPOSE 3000

COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
