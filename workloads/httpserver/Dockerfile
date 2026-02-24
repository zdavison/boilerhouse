FROM python:3-alpine

# Init process for container PID 1
RUN apk add --no-cache busybox-openrc openrc \
    && mkdir -p /run/openrc \
    && touch /run/openrc/softlevel

CMD ["/sbin/init"]
